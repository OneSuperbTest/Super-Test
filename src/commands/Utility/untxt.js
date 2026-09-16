import { SlashCommandBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';

/*
 * /untxt
 *
 * Slash:
 *   /untxt file:<.txt> one-by-one:<true/false>
 *
 * Prefix:
 *   !untxt
 *   !untxt 1x1
 *
 * The command reads a .txt file and sends its contents
 * into Discord.
 *
 * NORMAL MODE:
 * - Keeps complete lines together whenever possible.
 * - If adding another complete line would exceed
 *   Discord's 2000-character limit, that line starts
 *   the next Discord message.
 * - If a single line itself exceeds 2000 characters,
 *   that line is split into 2000-character chunks.
 *
 * ONE-BY-ONE MODE:
 * - Sends one line per Discord message.
 * - If a single line exceeds 2000 characters,
 *   that line is split into 2000-character chunks.
 *
 * PREFIX MODE:
 * - !untxt
 * - !untxt 1x1
 * - Supports a .txt attached directly to the command.
 * - Supports replying to a message containing a .txt file.
 * - Supports .txt files inside forwarded messages.
 */

const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10 MiB

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// Messages are sent sequentially with a delay.
// This prevents a large file from creating a burst
// of Discord requests.
const SEND_DELAY_MS = 1000;

const DOWNLOAD_TIMEOUT_MS = 60_000;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Split text into chunks of at most 2000 Unicode characters.
 *
 * Array.from() is used instead of String.slice() so
 * surrogate-pair characters such as many emoji are
 * not accidentally split in half.
 */
function splitIntoChunks(
  text,
  maxLength = DISCORD_MAX_MESSAGE_LENGTH
) {
  if (!text) {
    return [];
  }

  const characters = Array.from(text);
  const chunks = [];

  for (
    let index = 0;
    index < characters.length;
    index += maxLength
  ) {
    chunks.push(
      characters
        .slice(index, index + maxLength)
        .join('')
    );
  }

  return chunks;
}

/**
 * Normalize line endings so Windows, Linux and
 * old-Mac text files are handled consistently.
 */
function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * Convert bytes to a readable size.
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Download the text file with timeout and size protection.
 */
async function downloadTextFile(url) {
  if (!url) {
    throw new Error(
      'No text file URL was provided.'
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Discord-Untxt-Command/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(
        `Discord returned HTTP ${response.status} while downloading the text file.`
      );
    }

    const contentLength = Number(
      response.headers.get('content-length') || 0
    );

    if (contentLength > MAX_TEXT_FILE_SIZE) {
      throw new Error(
        `The text file is too large. The maximum allowed size is ${formatBytes(
          MAX_TEXT_FILE_SIZE
        )}.`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_TEXT_FILE_SIZE) {
      throw new Error(
        `The text file is too large. The maximum allowed size is ${formatBytes(
          MAX_TEXT_FILE_SIZE
        )}.`
      );
    }

    return buffer;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Determine whether an attachment is a .txt file.
 *
 * The filename is treated as the primary check because
 * Discord can sometimes provide a generic content type.
 */
function isTextAttachment(attachment) {
  if (!attachment) {
    return false;
  }

  const name = String(
    attachment.name || ''
  ).toLowerCase();

  const contentType = String(
    attachment.contentType || ''
  ).toLowerCase();

  return (
    name.endsWith('.txt') ||
    contentType === 'text/plain'
  );
}

/**
 * Find a .txt attachment in a Discord message.
 *
 * Checks:
 *
 * 1. Normal message attachments.
 * 2. Attachments contained inside forwarded-message
 *    snapshots.
 *
 * Discord forwarded messages do not necessarily expose
 * the original attachment through message.attachments.
 * Instead, discord.js can expose the forwarded message
 * through message.messageSnapshots.
 */
function getTextAttachment(message) {
  if (!message) {
    return null;
  }

  /*
   * -------------------------------------------------------
   * NORMAL MESSAGE ATTACHMENTS
   * -------------------------------------------------------
   */
  if (message.attachments?.size) {
    const attachment = [
      ...message.attachments.values(),
    ].find((attachment) =>
      isTextAttachment(attachment)
    );

    if (attachment) {
      return attachment;
    }
  }

  /*
   * -------------------------------------------------------
   * FORWARDED MESSAGE SNAPSHOTS
   * -------------------------------------------------------
   *
   * Discord forwarded messages can contain the original
   * message data inside message.messageSnapshots.
   *
   * Each snapshot can have its own attachments collection.
   */
  if (message.messageSnapshots?.size) {
    for (
      const snapshot
      of message.messageSnapshots.values()
    ) {
      if (!snapshot?.attachments?.size) {
        continue;
      }

      const attachment = [
        ...snapshot.attachments.values(),
      ].find((attachment) =>
        isTextAttachment(attachment)
      );

      if (attachment) {
        return attachment;
      }
    }
  }

  return null;
}

/**
 * Find the message that contained the prefix command
 * and, if necessary, the message being replied to.
 *
 * Supports:
 *
 * 1. .txt attached directly to !untxt
 * 2. .txt attached to a replied message
 * 3. .txt contained in a forwarded message
 * 4. !untxt replying to a forwarded message
 */
async function getPrefixSourceMessage(
  interaction
) {
  if (
    !interaction?.channel?.messages ||
    !interaction.commandId
  ) {
    return null;
  }

  /*
   * messageAdapter gives prefix commands a mock
   * interaction whose commandId is the original
   * prefix message ID.
   */
  const commandMessage =
    await interaction.channel.messages
      .fetch(interaction.commandId)
      .catch(() => null);

  if (!commandMessage) {
    return null;
  }

  /*
   * -------------------------------------------------------
   * DIRECT ATTACHMENT OR FORWARDED ATTACHMENT
   * -------------------------------------------------------
   *
   * This now checks both:
   *
   * commandMessage.attachments
   *
   * and
   *
   * commandMessage.messageSnapshots
   */
  const directOrForwardedAttachment =
    getTextAttachment(commandMessage);

  if (directOrForwardedAttachment) {
    return {
      commandMessage,
      sourceMessage: commandMessage,
      attachment:
        directOrForwardedAttachment,
    };
  }

  /*
   * -------------------------------------------------------
   * REPLIED MESSAGE
   * -------------------------------------------------------
   *
   * If !untxt is replying to another message, inspect
   * that message too.
   *
   * getTextAttachment() also checks forwarded snapshots,
   * so this supports replying to a forwarded message.
   */
  if (commandMessage.reference?.messageId) {
    const repliedMessage =
      await commandMessage
        .fetchReference()
        .catch(() => null);

    if (repliedMessage) {
      const attachment =
        getTextAttachment(
          repliedMessage
        );

      if (attachment) {
        return {
          commandMessage,
          sourceMessage: repliedMessage,
          attachment,
        };
      }
    }
  }

  return {
    commandMessage,
    sourceMessage: null,
    attachment: null,
  };
}

/**
 * Determine whether prefix one-by-one mode was requested.
 *
 * Supported:
 *
 * !untxt
 * !untxt 1x1
 */
function parseOneByOnePrefix(
  content,
  prefix
) {
  const input = String(content || '').trim();

  if (!input) {
    return false;
  }

  if (!input.startsWith(prefix)) {
    return false;
  }

  const withoutPrefix = input
    .slice(prefix.length)
    .trim();

  if (
    !/^untxt(?:\s|$)/i.test(
      withoutPrefix
    )
  ) {
    return false;
  }

  const remainder = withoutPrefix
    .slice(5)
    .trim()
    .toLowerCase();

  return remainder === '1x1';
}

/**
 * Send messages sequentially.
 *
 * Messages are never sent concurrently.
 */
async function sendMessages(
  channel,
  messages
) {
  let sent = 0;

  for (const content of messages) {
    if (!content) {
      continue;
    }

    await channel.send({
      content,
    });

    sent++;

    /*
     * Do not wait after the final message.
     */
    if (sent < messages.length) {
      await sleep(SEND_DELAY_MS);
    }
  }

  return sent;
}

/**
 * NORMAL MODE
 *
 * Keep complete lines together whenever possible.
 *
 * Example:
 *
 * Lines 1-73 fit within 2000 characters.
 * Adding line 74 would make the message exceed 2000.
 *
 * Result:
 *
 * Message 1:
 *   Line 1
 *   Line 2
 *   ...
 *   Line 73
 *
 * Message 2:
 *   Line 74
 *   Line 75
 *   ...
 *
 * A line itself longer than 2000 characters is split
 * separately.
 */
async function sendNormalMode(
  channel,
  text
) {
  const lines = text.split('\n');

  const messages = [];

  let currentMessage = '';

  for (const line of lines) {
    /*
     * If this individual line is already longer than
     * Discord's limit, flush the current message first.
     */
    if (
      Array.from(line).length >
      DISCORD_MAX_MESSAGE_LENGTH
    ) {
      if (currentMessage) {
        messages.push(currentMessage);
        currentMessage = '';
      }

      /*
       * Split ONLY this oversized line.
       */
      const longLineChunks =
        splitIntoChunks(
          line,
          DISCORD_MAX_MESSAGE_LENGTH
        );

      messages.push(
        ...longLineChunks
      );

      continue;
    }

    /*
     * Preserve the newline between complete lines.
     */
    const candidate = currentMessage
      ? `${currentMessage}\n${line}`
      : line;

    /*
     * If the complete line would cause the message
     * to exceed 2000 characters, don't split the line.
     *
     * Send the previous lines and start a new message
     * with this line.
     */
    if (
      Array.from(candidate).length >
      DISCORD_MAX_MESSAGE_LENGTH
    ) {
      if (currentMessage) {
        messages.push(currentMessage);
      }

      currentMessage = line;
    } else {
      currentMessage = candidate;
    }
  }

  /*
   * Send whatever remains.
   */
  if (currentMessage) {
    messages.push(currentMessage);
  }

  if (!messages.length) {
    throw new Error(
      'The `.txt` file is empty.'
    );
  }

  return sendMessages(
    channel,
    messages
  );
}

/**
 * ONE-BY-ONE MODE
 *
 * Every line gets its own Discord message.
 *
 * If a line exceeds 2000 characters,
 * that individual line is split into
 * multiple 2000-character chunks.
 */
async function sendOneByOneMode(
  channel,
  text
) {
  const lines = text.split('\n');

  const messages = [];

  for (const line of lines) {
    /*
     * Discord doesn't allow a completely empty message.
     *
     * A zero-width space keeps the blank line visually
     * blank while still giving Discord message content.
     */
    if (line.length === 0) {
      messages.push('\u200B');
      continue;
    }

    const chunks = splitIntoChunks(
      line,
      DISCORD_MAX_MESSAGE_LENGTH
    );

    messages.push(
      ...chunks
    );
  }

  if (!messages.length) {
    throw new Error(
      'The `.txt` file is empty.'
    );
  }

  return sendMessages(
    channel,
    messages
  );
}

/**
 * Process the actual text file.
 */
async function processTextFile({
  channel,
  attachment,
  oneByOne,
}) {
  if (!attachment?.url) {
    throw new Error(
      'Please provide a `.txt` file.'
    );
  }

  if (!isTextAttachment(attachment)) {
    throw new Error(
      'The uploaded file must be a `.txt` file.'
    );
  }

  const buffer =
    await downloadTextFile(
      attachment.url
    );

  const text = normalizeText(
    buffer.toString('utf8')
  );

  if (text.length === 0) {
    throw new Error(
      'The `.txt` file is empty.'
    );
  }

  const sent = oneByOne
    ? await sendOneByOneMode(
        channel,
        text
      )
    : await sendNormalMode(
        channel,
        text
      );

  return {
    sent,
    oneByOne,
    characters:
      Array.from(text).length,
  };
}

/**
 * SLASH COMMAND EXECUTION
 *
 * /untxt
 *   file: [TXT FILE]
 *   one-by-one: [TRUE/FALSE]
 */
async function runSlash(interaction) {
  const attachment =
    interaction.options.getAttachment(
      'file'
    );

  const oneByOne =
    interaction.options.getBoolean(
      'one-by-one'
    ) ?? false;

  if (!attachment) {
    return interaction.reply({
      content:
        '❌ Please upload a `.txt` file using the **file** option.',
      ephemeral: true,
    });
  }

  if (
    !isTextAttachment(attachment)
  ) {
    return interaction.reply({
      content:
        '❌ The uploaded file must be a `.txt` file.',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const result =
      await processTextFile({
        channel:
          interaction.channel,
        attachment,
        oneByOne,
      });

    await interaction.editReply(
      oneByOne
        ? `✅ Sent ${result.sent} message${
            result.sent === 1
              ? ''
              : 's'
          } one line at a time.`
        : `✅ Sent ${result.sent} message${
            result.sent === 1
              ? ''
              : 's'
          } from the text file.`
    );
  } catch (error) {
    logger.error(
      'Untxt slash command error:',
      error
    );

    const message =
      error?.name === 'AbortError'
        ? '❌ The `.txt` file download timed out.'
        : `❌ ${
            error?.message ||
            'Failed to read the text file.'
          }`;

    await interaction
      .editReply(message)
      .catch(() => {});
  }
}

/**
 * PREFIX COMMAND EXECUTION
 *
 * Supported:
 *
 * !untxt
 *
 * !untxt 1x1
 *
 * The .txt can either be attached directly,
 * attached to a forwarded message, or be attached
 * to the message being replied to.
 */
async function runPrefix(
  interaction,
  config
) {
  const source =
    await getPrefixSourceMessage(
      interaction
    );

  if (!source?.attachment) {
    await interaction.reply(
      '❌ Please attach a `.txt` file to this message or reply to a message containing a `.txt` file.'
    );

    return;
  }

  const prefix =
    config?.prefix || '!';

  const oneByOne =
    parseOneByOnePrefix(
      source.commandMessage?.content,
      prefix
    );

  await interaction.deferReply();

  try {
    const result =
      await processTextFile({
        channel:
          interaction.channel,
        attachment:
          source.attachment,
        oneByOne,
      });

    await interaction.editReply(
      oneByOne
        ? `✅ Sent ${result.sent} message${
            result.sent === 1
              ? ''
              : 's'
          } one line at a time.`
        : `✅ Sent ${result.sent} message${
            result.sent === 1
              ? ''
              : 's'
          } from the text file.`
    );
  } catch (error) {
    logger.error(
      'Untxt prefix command error:',
      error
    );

    const message =
      error?.name === 'AbortError'
        ? '❌ The `.txt` file download timed out.'
        : `❌ ${
            error?.message ||
            'Failed to read the text file.'
          }`;

    await interaction
      .editReply(message)
      .catch(() => {});
  }
}

/*
 * =========================================================
 * DISCORD COMMAND DEFINITION
 * =========================================================
 *
 * There is NO .addSubcommand() here.
 *
 * Therefore Discord displays:
 *
 *   /untxt
 *      file
 *      one-by-one
 *
 * NOT:
 *
 *   /untxt file
 *      file
 *      one-by-one
 */

export default {
  data: new SlashCommandBuilder()
    .setName('untxt')
    .setDescription(
      'Sends the text insite the .txt file'
    )

    /*
     * The TXT attachment is directly under /untxt.
     */
    .addAttachmentOption((option) =>
      option
        .setName('file')
        .setDescription(
          'The .txt file to read'
        )
        .setRequired(true)
    )

    /*
     * Optional True/False option.
     *
     * If the user does not select it,
     * the code above defaults it to false.
     */
    .addBooleanOption((option) =>
      option
        .setName('one-by-one')
        .setDescription(
          'bot send one line at a time'
        )
        .setRequired(false)
    ),

  category: 'Utility',

  abuseProtection: {
    maxAttempts: 3,
    windowMs: 60_000,
  },

  /*
   * Prefix syntax intentionally does not mirror
   * the slash-command structure.
   *
   * Slash:
   *   /untxt file:<file>
   *
   * Prefix:
   *   !untxt
   *   !untxt 1x1
   */
  prefixExecute: runPrefix,

  /*
   * Required slash options should NOT be validated
   * against the prefix command because prefix mode
   * obtains the file from the message/reply.
   */
  prefixBypassValidation: true,

  async execute(
    interaction,
    config,
    client
  ) {
    await runSlash(interaction);
  },
};
