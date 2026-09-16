import
 {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags
} from 'discord.js';

import { successEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  replyUserError,
  ErrorTypes
} from '../../utils/errorHandler.js';


// Maximum amount that can be requested
const MAX_PURGE_AMOUNT = 1000;

// Discord allows a maximum of 100 messages per bulkDelete request
const DELETE_BATCH_SIZE = 100;


export default {
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Delete a specific amount of messages")
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Number of messages (1-1000)")
        .setMinValue(1)
        .setMaxValue(MAX_PURGE_AMOUNT)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  category: "moderation",

  abuseProtection: {
    maxAttempts: 5,
    windowMs: 60_000
  },


  async execute(interaction, config, client) {

    // =========================================================
    // DEFER
    // =========================================================

    const deferSuccess = await InteractionHelper.safeDefer(interaction, {
      flags: MessageFlags.Ephemeral,
    });

    if (!deferSuccess) {
      logger.warn(`Purge interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'purge'
      });

      return;
    }


    // =========================================================
    // GET OPTIONS
    // =========================================================

    const amount = interaction.options.getInteger("amount");
    const channel = interaction.channel;


    // =========================================================
    // VALIDATION
    // =========================================================

    if (
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > MAX_PURGE_AMOUNT
    ) {
      return await replyUserError(interaction, {
        type: ErrorTypes.VALIDATION,
        message: `Please specify a number between 1 and ${MAX_PURGE_AMOUNT}.`
      });
    }


    // =========================================================
    // PREFIX COMMAND
    // =========================================================
    //
    // !purge 5
    //
    // Deletes:
    //   5 messages
    //   + the !purge 5 command
    //
    // Total = 6
    //
    // =========================================================

    if (interaction._isPrefixCommand) {

      let remaining = amount;
      let totalDeleted = 0;

      // Start BEFORE the prefix command so the command itself
      // does not count toward the requested amount.
      let beforeId = interaction.id;


      try {

        // -------------------------------------------------------
        // Delete requested messages in batches of 100
        // -------------------------------------------------------

        while (remaining > 0) {

          const batchSize = Math.min(
            DELETE_BATCH_SIZE,
            remaining
          );


          const fetched = await channel.messages.fetch({
            limit: batchSize,
            before: beforeId
          });


          // No more messages available
          if (fetched.size === 0) {
            break;
          }


          // Save the oldest message before deleting it.
          // This allows the next batch to continue backwards.
          const oldestMessage = fetched.last();


          const deleted = await channel.bulkDelete(
            fetched,
            true
          );


          totalDeleted += deleted.size;
          remaining -= deleted.size;


          if (oldestMessage) {
            beforeId = oldestMessage.id;
          }


          // If Discord could not delete anything, the remaining
          // messages are likely older than 14 days.
          if (deleted.size === 0) {
            break;
          }
        }


        // -------------------------------------------------------
        // Delete the !purge command itself
        // -------------------------------------------------------

        let commandDeleted = false;

        try {

          const commandMessage = await channel.messages.fetch(
            interaction.id
          ).catch(() => null);


          if (commandMessage && commandMessage.deletable) {
            await commandMessage.delete();
            commandDeleted = true;
          }

        } catch (error) {

          logger.debug(
            'Failed to delete purge prefix command:',
            error
          );
        }


        // -------------------------------------------------------
        // Final count
        // -------------------------------------------------------

        const finalDeletedCount =
          totalDeleted;


        // -------------------------------------------------------
        // LOG
        // -------------------------------------------------------

        await logEvent({
          client,
          guild: interaction.guild,
          event: {
            action: "Messages Purged",

            target:
              `${channel} (${finalDeletedCount} messages)`,

            executor:
              `${interaction.user.tag} (${interaction.user.id})`,

            reason:
              `Deleted ${finalDeletedCount} messages ` +
              `(${totalDeleted} requested messages + purge command)`,

            metadata: {
              channelId: channel.id,
              messageCount: finalDeletedCount,
              requestedAmount: amount,
              moderatorId: interaction.user.id,
              prefixCommandDeleted: commandDeleted
            }
          }
        });


        // -------------------------------------------------------
        // CONFIRMATION
        // -------------------------------------------------------

        const response = await channel.send({
          embeds: [
            successEmbed(
              "Messages Purged",
              `Deleted ${finalDeletedCount} messages in ${channel}.`
            )
          ]
        });


        // Remove confirmation after 3 seconds
        setTimeout(() => {
          response.delete().catch(err =>
            logger.debug(
              'Failed to auto-delete purge response:',
              err
            )
          );
        }, 3000);


        return;

      } catch (error) {

        logger.error(
          'Prefix purge command error:',
          error
        );


        await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message:
            'An unexpected error occurred during message deletion. ' +
            'Note: Messages older than 14 days cannot be bulk deleted.'
        });

        return;
      }
    }


    // =========================================================
    // SLASH COMMAND
    // =========================================================
    //
    // /purge amount:5
    //     = 5 messages
    //
    // /purge amount:1000
    //     = 1000 messages
    //
    // The slash command interaction itself is NOT counted.
    //
    // =========================================================

    try {

      let remaining = amount;
      let totalDeleted = 0;

      let beforeId = null;


      // -------------------------------------------------------
      // Delete in batches of 100
      // -------------------------------------------------------

      while (remaining > 0) {

        const batchSize = Math.min(
          DELETE_BATCH_SIZE,
          remaining
        );


        const fetchOptions = {
          limit: batchSize
        };


        // After the first batch, continue further backwards
        if (beforeId) {
          fetchOptions.before = beforeId;
        }


        const fetched = await channel.messages.fetch(
          fetchOptions
        );


        // No more messages available
        if (fetched.size === 0) {
          break;
        }


        // Save oldest message before deleting
        const oldestMessage = fetched.last();


        const deleted = await channel.bulkDelete(
          fetched,
          true
        );


        totalDeleted += deleted.size;
        remaining -= deleted.size;


        if (oldestMessage) {
          beforeId = oldestMessage.id;
        }


        // Messages older than 14 days cannot be bulk deleted
        if (deleted.size === 0) {
          break;
        }
      }


      // -------------------------------------------------------
      // LOG
      // -------------------------------------------------------

      await logEvent({
        client,
        guild: interaction.guild,
        event: {
          action: "Messages Purged",

          target:
            `${channel} (${totalDeleted} messages)`,

          executor:
            `${interaction.user.tag} (${interaction.user.id})`,

          reason:
            `Deleted ${totalDeleted} messages`,

          metadata: {
            channelId: channel.id,
            messageCount: totalDeleted,
            requestedAmount: amount,
            moderatorId: interaction.user.id
          }
        }
      });


      // -------------------------------------------------------
      // SLASH RESPONSE
      // -------------------------------------------------------

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            "Messages Purged",
            `Deleted ${totalDeleted} messages in ${channel}.`
          )
        ],
        flags: MessageFlags.Ephemeral,
      });


      // Delete ephemeral response after 3 seconds
      setTimeout(() => {
        interaction.deleteReply().catch(err =>
          logger.debug(
            'Failed to auto-delete purge response:',
            err
          )
        );
      }, 3000);


    } catch (error) {

      logger.error(
        'Purge command error:',
        error
      );


      await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message:
          'An unexpected error occurred during message deletion. ' +
          'Note: Messages older than 14 days cannot be bulk deleted.'
      });
    }
  }
};
