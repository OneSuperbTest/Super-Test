import { SlashCommandBuilder } from 'discord.js';
import { inflateRawSync } from 'node:zlib';
import { logger } from '../../utils/logger.js';

const MAX_ZIP_SIZE = 50 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_TOTAL_UNCOMPRESSED = 500 * 1024 * 1024;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const SEND_DELAY_MS = 250;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalizes and validates a ZIP path.
 *
 * ZIP paths must never be allowed to escape the archive root.
 */
function safeZipPath(input) {
    let value = String(input ?? '').replace(/\\/g, '/');

    while (value.startsWith('/')) {
        value = value.slice(1);
    }

    const parts = value.split('/').filter(Boolean);

    if (parts.some(part => part === '..')) {
        throw new Error('Unsafe archive path detected.');
    }

    if (parts.some(part => part === '.')) {
        throw new Error('Unsafe archive path detected.');
    }

    return parts.join('/');
}

function isDirectoryName(name) {
    return name.endsWith('/');
}

function basename(path) {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
}

/**
 * Parse a normal ZIP archive.
 *
 * Supports:
 * - Stored files
 * - Deflate files
 *
 * ZIP64 and encrypted ZIPs are rejected.
 */
function parseZip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    function u16(offset) {
        return view.getUint16(offset, true);
    }

    function u32(offset) {
        return view.getUint32(offset, true);
    }

    // Find End Of Central Directory record.
    const minEOCD = 22;
    const maxComment = 0xffff;

    let eocdOffset = -1;

    const start = Math.max(
        0,
        buffer.length - minEOCD - maxComment
    );

    for (let i = buffer.length - minEOCD; i >= start; i--) {
        if (u32(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }

    if (eocdOffset === -1) {
        throw new Error('The uploaded file is not a valid ZIP archive.');
    }

    const diskNumber = u16(eocdOffset + 4);
    const centralDirectoryDisk = u16(eocdOffset + 6);
    const entriesOnDisk = u16(eocdOffset + 8);
    const totalEntries = u16(eocdOffset + 10);
    const centralDirectorySize = u32(eocdOffset + 12);
    const centralDirectoryOffset = u32(eocdOffset + 16);

    if (
        diskNumber !== 0 ||
        centralDirectoryDisk !== 0 ||
        entriesOnDisk !== totalEntries
    ) {
        throw new Error('Multi-disk ZIP archives are not supported.');
    }

    // ZIP64 detection.
    if (
        totalEntries === 0xffff ||
        centralDirectorySize === 0xffffffff ||
        centralDirectoryOffset === 0xffffffff
    ) {
        throw new Error('ZIP64 archives are not supported.');
    }

    if (totalEntries > MAX_FILES) {
        throw new Error(
            `This archive contains too many files. Maximum allowed is ${MAX_FILES}.`
        );
    }

    const centralEnd =
        centralDirectoryOffset + centralDirectorySize;

    if (
        centralDirectoryOffset > buffer.length ||
        centralEnd > buffer.length
    ) {
        throw new Error('The ZIP central directory is invalid.');
    }

    const entries = [];

    let offset = centralDirectoryOffset;
    let totalUncompressed = 0;

    for (let i = 0; i < totalEntries; i++) {
        if (offset + 46 > buffer.length) {
            throw new Error('The ZIP central directory is corrupted.');
        }

        if (u32(offset) !== 0x02014b50) {
            throw new Error('Invalid ZIP central directory entry.');
        }

        const flags = u16(offset + 8);
        const compressionMethod = u16(offset + 10);

        const compressedSize = u32(offset + 20);
        const uncompressedSize = u32(offset + 24);

        const fileNameLength = u16(offset + 28);
        const extraLength = u16(offset + 30);
        const commentLength = u16(offset + 32);

        const localHeaderOffset = u32(offset + 42);

        const nameStart = offset + 46;
        const nameEnd = nameStart + fileNameLength;

        if (nameEnd > buffer.length) {
            throw new Error('Invalid ZIP filename.');
        }

        const nameBytes = bytes.slice(nameStart, nameEnd);

        let name;

        try {
            name = new TextDecoder(
                (flags & 0x800) !== 0 ? 'utf-8' : 'utf-8',
                { fatal: false }
            ).decode(nameBytes);
        } catch {
            throw new Error('Unable to decode a ZIP filename.');
        }

        name = safeZipPath(name);

        if (!name) {
            offset =
                nameEnd +
                extraLength +
                commentLength;
            continue;
        }

        const directory =
            isDirectoryName(name) ||
            ((externalDirectoryFlag(flags)) === true);

        if (!directory) {
            if (uncompressedSize > MAX_FILE_SIZE) {
                throw new Error(
                    `File "${name}" is too large. Maximum allowed is ${formatBytes(MAX_FILE_SIZE)}.`
                );
            }

            totalUncompressed += uncompressedSize;

            if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
                throw new Error(
                    `The archive expands to more than the allowed ${formatBytes(MAX_TOTAL_UNCOMPRESSED)}.`
                );
            }
        }

        if (flags & 0x1) {
            throw new Error(
                `Encrypted ZIP entry "${name}" is not supported.`
            );
        }

        if (
            compressedSize > buffer.length ||
            uncompressedSize > MAX_TOTAL_UNCOMPRESSED
        ) {
            throw new Error(`Invalid ZIP entry "${name}".`);
        }

        entries.push({
            path: name,
            directory,
            compressionMethod,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
            buffer,
            getData() {
                return extractZipEntry(this);
            }
        });

        offset =
            nameEnd +
            extraLength +
            commentLength;
    }

    return entries;
}

/**
 * ZIP external attribute directory detection.
 *
 * Kept deliberately conservative because different ZIP creators
 * store directory attributes differently.
 */
function externalDirectoryFlag() {
    return false;
}

function extractZipEntry(entry) {
    const buffer = entry.buffer;
    const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength
    );

    const offset = entry.localHeaderOffset;

    if (offset + 30 > buffer.length) {
        throw new Error(`Invalid local header for "${entry.path}".`);
    }

    if (view.getUint32(offset, true) !== 0x04034b50) {
        throw new Error(`Invalid local header for "${entry.path}".`);
    }

    const fileNameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);

    const dataStart =
        offset +
        30 +
        fileNameLength +
        extraLength;

    const dataEnd =
        dataStart +
        entry.compressedSize;

    if (
        dataStart < 0 ||
        dataEnd > buffer.length ||
        dataStart > dataEnd
    ) {
        throw new Error(`Invalid compressed data for "${entry.path}".`);
    }

    const compressed = Buffer.from(
        buffer.subarray(dataStart, dataEnd)
    );

    let result;

    if (entry.compressionMethod === 0) {
        result = compressed;
    } else if (entry.compressionMethod === 8) {
        result = inflateRawSync(compressed, {
            maxOutputLength: MAX_FILE_SIZE
        });
    } else {
        throw new Error(
            `ZIP compression method ${entry.compressionMethod} is not supported for "${entry.path}".`
        );
    }

    if (result.length !== entry.uncompressedSize) {
        throw new Error(
            `Extracted size mismatch for "${entry.path}".`
        );
    }

    if (result.length > MAX_FILE_SIZE) {
        throw new Error(
            `File "${entry.path}" exceeds the maximum file size.`
        );
    }

    return result;
}

function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    if (bytes < 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function downloadFile(url) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(
                `Failed to download the archive. HTTP ${response.status}.`
            );
        }

        const contentLength = response.headers.get('content-length');

        if (
            contentLength &&
            Number(contentLength) > MAX_ZIP_SIZE
        ) {
            throw new Error(
                `The archive is too large. Maximum allowed size is ${formatBytes(MAX_ZIP_SIZE)}.`
            );
        }

        const arrayBuffer = await response.arrayBuffer();

        if (arrayBuffer.byteLength > MAX_ZIP_SIZE) {
            throw new Error(
                `The archive is too large. Maximum allowed size is ${formatBytes(MAX_ZIP_SIZE)}.`
            );
        }

        return Buffer.from(arrayBuffer);
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error(
                'The archive download timed out.'
            );
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function normalizeDirectory(directory) {
    return String(directory ?? '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
}

/**
 * Gets every directory anywhere in the archive.
 *
 * Directories are inferred from file paths too, so archives that
 * don't contain explicit directory entries still get listed correctly.
 */
function getFolderNames(entries) {
    const folders = new Set();

    for (const entry of entries) {
        const path = entry.path.replace(/\\/g, '/');

        if (entry.directory) {
            const directoryPath = path.replace(/\/+$/, '');

            if (directoryPath) {
                addParentFolders(directoryPath, folders);
            }

            continue;
        }

        const parts = path.split('/');

        // A root-level file has no directory.
        if (parts.length <= 1) {
            continue;
        }

        parts.pop();

        for (let i = 1; i <= parts.length; i++) {
            folders.add(parts.slice(0, i).join('/'));
        }
    }

    return [...folders].sort((a, b) =>
        a.localeCompare(b, undefined, {
            numeric: true,
            sensitivity: 'base'
        })
    );
}

function addParentFolders(path, folders) {
    const parts = path.split('/').filter(Boolean);

    for (let i = 1; i <= parts.length; i++) {
        folders.add(parts.slice(0, i).join('/'));
    }
}

/**
 * Finds the specified directory.
 *
 * Paths are matched exactly after normalization.
 *
 * This is important because:
 *
 * !unzip apple
 *
 * must mean the actual "apple" directory and must not accidentally
 * select another directory merely because it happens to have the
 * same basename somewhere else.
 */
function findDirectory(entries, requestedDirectory) {
    const wanted = normalizeDirectory(requestedDirectory);

    if (!wanted) {
        return null;
    }

    const exact = entries.find(entry => {
        if (!entry.directory) {
            return false;
        }

        return normalizeDirectory(entry.path) === wanted;
    });

    if (exact) {
        return normalizeDirectory(exact.path);
    }

    // Archives are allowed to omit explicit directory entries.
    // Therefore also recognize a directory if files imply it.
    const prefix = `${wanted}/`;

    const implied = entries.some(entry =>
        !entry.directory &&
        entry.path.startsWith(prefix)
    );

    if (implied) {
        return wanted;
    }

    return null;
}

/**
 * IMPORTANT:
 *
 * This intentionally returns ONLY files directly inside the selected
 * directory.
 *
 * It does NOT recursively enter subdirectories.
 *
 * Example:
 *
 * apple/
 * apple/a.txt
 * apple/banana/b.txt
 * apple/orange/c.txt
 *
 * Selecting "apple" returns only:
 *
 * apple/a.txt
 *
 * It does NOT return:
 *
 * apple/banana/b.txt
 * apple/orange/c.txt
 */
function getFilesForDirectory(entries, requestedDirectory) {
    const directory = normalizeDirectory(requestedDirectory);

    if (!directory) {
        return [];
    }

    const prefix = `${directory}/`;

    return entries.filter(entry => {
        if (entry.directory) {
            return false;
        }

        if (!entry.path.startsWith(prefix)) {
            return false;
        }

        const relativePath = entry.path.slice(prefix.length);

        // Only direct children.
        // Anything containing another "/" is inside a subdirectory.
        return !relativePath.includes('/');
    });
}

function getRootFiles(entries) {
    return entries.filter(entry => {
        if (entry.directory) {
            return false;
        }

        return !entry.path.includes('/');
    });
}

function getAllFiles(entries) {
    return entries.filter(entry => !entry.directory);
}

function isZipAttachment(attachment) {
    if (!attachment) {
        return false;
    }

    const name = String(attachment.name ?? '').toLowerCase();
    const contentType = String(
        attachment.contentType ?? ''
    ).toLowerCase();

    return (
        name.endsWith('.zip') ||
        contentType === 'application/zip' ||
        contentType === 'application/x-zip-compressed'
    );
}

/**
 * Gets attachments from a Discord message and from message snapshots.
 */
function getAttachmentFromMessage(message) {
    if (!message) {
        return null;
    }

    if (message.attachments?.size) {
        for (const attachment of message.attachments.values()) {
            if (isZipAttachment(attachment)) {
                return attachment;
            }
        }

        const first = message.attachments.first();

        if (first) {
            return first;
        }
    }

    if (message.messageSnapshots?.size) {
        for (const snapshot of message.messageSnapshots.values()) {
            if (snapshot?.attachments?.size) {
                for (const attachment of snapshot.attachments.values()) {
                    if (isZipAttachment(attachment)) {
                        return attachment;
                    }
                }

                const first = snapshot.attachments.first();

                if (first) {
                    return first;
                }
            }
        }
    }

    return null;
}

/**
 * Attempts to locate the original prefix-command message.
 *
 * Different messageAdapter implementations expose it differently,
 * so several common properties are supported.
 */
async function getPrefixSourceMessage(interaction) {
    const possibleMessages = [
        interaction.message,
        interaction.commandMessage,
        interaction.sourceMessage,
        interaction._message,
        interaction._sourceMessage
    ];

    for (const message of possibleMessages) {
        if (message) {
            return message;
        }
    }

    const messageId =
        interaction.commandId ||
        interaction.messageId ||
        interaction.sourceMessageId ||
        interaction._messageId;

    if (
        messageId &&
        interaction.channel?.messages?.fetch
    ) {
        try {
            return await interaction.channel.messages.fetch(
                messageId
            );
        } catch {
            // Continue to other methods.
        }
    }

    return null;
}

async function getPrefixZipAttachment(interaction) {
    const commandMessage =
        await getPrefixSourceMessage(interaction);

    if (!commandMessage) {
        return null;
    }

    // Direct attachment.
    const direct =
        getAttachmentFromMessage(commandMessage);

    if (direct) {
        return direct;
    }

    // Reply attachment.
    const referenceId =
        commandMessage.reference?.messageId;

    if (
        referenceId &&
        commandMessage.channel?.messages?.fetch
    ) {
        try {
            const repliedMessage =
                await commandMessage.channel.messages.fetch(
                    referenceId
                );

            const replyAttachment =
                getAttachmentFromMessage(repliedMessage);

            if (replyAttachment) {
                return replyAttachment;
            }
        } catch {
            // Ignore and continue.
        }
    }

    return null;
}

/**
 * Parses:
 *
 * !unzip
 * !unzip apple
 * !unzip "apple"
 * !unzip "apple/banana"
 * !unzip all
 */
function parsePrefixArguments(content, prefix) {
    const text = String(content ?? '').trim();

    if (!text) {
        return null;
    }

    if (!text.toLowerCase().startsWith(
        `${String(prefix).toLowerCase()}unzip`
    )) {
        return null;
    }

    const remainder = text.slice(
        `${prefix}unzip`.length
    ).trim();

    if (!remainder) {
        return {
            directory: null,
            all: false
        };
    }

    // Quoted argument.
    if (
        (remainder.startsWith('"') &&
            remainder.endsWith('"')) ||
        (remainder.startsWith("'") &&
            remainder.endsWith("'"))
    ) {
        const directory =
            remainder.slice(1, -1);

        return {
            directory,
            all: false
        };
    }

    // Unquoted "all" is ALWAYS the special keyword.
    if (remainder.toLowerCase() === 'all') {
        return {
            directory: null,
            all: true
        };
    }

    return {
        directory: remainder,
        all: false
    };
}

async function sendExtractedFiles(interaction, entries) {
    let sent = 0;

    for (const entry of entries) {
        const data = entry.getData();

        if (!data || data.length === 0) {
            continue;
        }

        const fileName = basename(entry.path);

        await interaction.channel.send({
            files: [
                {
                    attachment: data,
                    name: fileName
                }
            ]
        });

        sent++;

        if (SEND_DELAY_MS > 0) {
            await sleep(SEND_DELAY_MS);
        }
    }

    return sent;
}

async function sendFolderList(interaction, folders) {
    if (!folders.length) {
        return;
    }

    await interaction.channel.send({
        content:
            `Folders\n\n${folders.join('\n')}`
    });
}

/**
 * Sends the final confirmation privately.
 *
 * The extracted files and folder list remain public.
 * Only this confirmation is ephemeral.
 */
async function sendPrivateConfirmation(
    interaction,
    amount
) {
    const content =
        `✅ Extracted ${amount} ${amount === 1 ? 'file' : 'files'}`;

    try {
        // If this is a real Discord interaction, this will be
        // visible only to the command executor.
        if (typeof interaction.editReply === 'function') {
            await interaction.editReply({
                content,
                ephemeral: true
            });

            return;
        }
    } catch {
        // Fall through to followUp.
    }

    try {
        if (typeof interaction.followUp === 'function') {
            await interaction.followUp({
                content,
                ephemeral: true
            });

            return;
        }
    } catch {
        // Ignore.
    }

    // Last-resort fallback for unusual messageAdapter objects.
    // This should normally not be reached.
    try {
        await interaction.channel.send({
            content
        });
    } catch {
        // Ignore.
    }
}

async function processZip(
    interaction,
    attachment,
    requestedDirectory = null,
    all = false
) {
    if (!attachment?.url) {
        throw new Error(
            'No ZIP archive attachment was found.'
        );
    }

    if (!isZipAttachment(attachment)) {
        throw new Error(
            'Please provide a ZIP archive.'
        );
    }

    if (
        attachment.size &&
        Number(attachment.size) > MAX_ZIP_SIZE
    ) {
        throw new Error(
            `The archive is too large. Maximum allowed size is ${formatBytes(MAX_ZIP_SIZE)}.`
        );
    }

    const buffer =
        await downloadFile(attachment.url);

    const entries =
        parseZip(buffer);

    const folders =
        getFolderNames(entries);

    let filesToExtract = [];

    if (all) {
        filesToExtract =
            getAllFiles(entries);
    } else if (requestedDirectory) {
        const normalized =
            normalizeDirectory(requestedDirectory);

        if (!normalized) {
            filesToExtract =
                getRootFiles(entries);
        } else {
            const directory =
                findDirectory(
                    entries,
                    normalized
                );

            if (!directory) {
                throw new Error(
                    `The directory "${requestedDirectory}" was not found in the archive.`
                );
            }

            /*
             * IMPORTANT:
             *
             * Only direct files are extracted.
             *
             * Files in child folders are NOT extracted.
             */
            filesToExtract =
                getFilesForDirectory(
                    entries,
                    directory
                );
        }
    } else {
        // !unzip with no directory:
        // root-level files only.
        filesToExtract =
            getRootFiles(entries);
    }

    const extractedCount =
        await sendExtractedFiles(
            interaction,
            filesToExtract
        );

    // Folder list is sent AFTER file extraction has completely finished.
    await sendFolderList(
        interaction,
        folders
    );

    await sendPrivateConfirmation(
        interaction,
        extractedCount
    );

    return extractedCount;
}

async function runSlash(interaction) {
    const attachment =
        interaction.options.getAttachment('file');

    const directory =
        interaction.options.getString('directory');

    const all =
        interaction.options.getBoolean('all') ?? false;

    if (directory && all) {
        await interaction.reply({
            content:
                'You cannot specify a directory and `all:true` at the same time.',
            ephemeral: true
        });

        return;
    }

    await interaction.deferReply({
        ephemeral: true
    });

    try {
        await processZip(
            interaction,
            attachment,
            directory,
            all
        );
    } catch (error) {
        logger.error?.(
            '[unzip] Slash command failed:',
            error
        );

        try {
            await interaction.editReply({
                content:
                    `❌ ${error?.message || 'Failed to unzip the archive.'}`,
                ephemeral: true
            });
        } catch {
            // Ignore secondary reply errors.
        }
    }
}

async function runPrefix(interaction) {
    const config =
        interaction.client?.config ||
        interaction.client?.settings ||
        {};

    const prefix =
        config.prefix ||
        interaction.prefix ||
        '!';

    interaction._prefix = prefix;

    const sourceMessage =
        await getPrefixSourceMessage(interaction);

    if (!sourceMessage) {
        try {
            await interaction.reply?.({
                content:
                    '❌ I could not find the original command message.',
                ephemeral: true
            });
        } catch {
            // Ignore.
        }

        return;
    }

    const parsed =
        parsePrefixArguments(
            sourceMessage.content,
            prefix
        );

    if (!parsed) {
        try {
            await interaction.reply?.({
                content:
                    '❌ Invalid unzip command.',
                ephemeral: true
            });
        } catch {
            // Ignore.
        }

        return;
    }

    const attachment =
        await getPrefixZipAttachment(
            interaction
        );

    if (!attachment) {
        try {
            await interaction.reply?.({
                content:
                    '❌ Please attach a ZIP archive, reply to a message containing one, or use a forwarded message containing the archive.',
                ephemeral: true
            });
        } catch {
            // Ignore.
        }

        return;
    }

    if (!isZipAttachment(attachment)) {
        try {
            await interaction.reply?.({
                content:
                    '❌ The attached file must be a ZIP archive.',
                ephemeral: true
            });
        } catch {
            // Ignore.
        }

        return;
    }

    /*
     * The adapter may perform its own validation before prefixExecute.
     * This command intentionally bypasses slash-option validation because
     * prefix commands do not use slash options.
     */
    await interaction.deferReply({
        ephemeral: true
    });

    try {
        await processZip(
            interaction,
            attachment,
            parsed.directory,
            parsed.all
        );
    } catch (error) {
        logger.error?.(
            '[unzip] Prefix command failed:',
            error
        );

        try {
            await interaction.editReply({
                content:
                    `❌ ${error?.message || 'Failed to unzip the archive.'}`,
                ephemeral: true
            });
        } catch {
            // Ignore secondary reply errors.
        }
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('unzip')
        .setDescription('Unzip a file')

        .addAttachmentOption(option =>
            option
                .setName('file')
                .setDescription('ZIP archive to unzip')
                .setRequired(true)
        )

        .addStringOption(option =>
            option
                .setName('directory')
                .setDescription(
                    'Only extract files directly inside this directory'
                )
                .setRequired(false)
        )

        .addBooleanOption(option =>
            option
                .setName('all')
                .setDescription(
                    'Extract all files in the archive'
                )
                .setRequired(false)
        ),

    category: 'Utility',

    abuseProtection: {
        maxAttempts: 3,
        windowMs: 60_000
    },

    prefixExecute: runPrefix,

    prefixBypassValidation: true,

    async execute(interaction) {
        await runSlash(interaction);
    }
};
