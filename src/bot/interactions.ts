import { handleChatInputCommand } from "./handlers/chat-commands";
import { handleAutocomplete } from "./handlers/autocomplete";
import { handleButton } from "./handlers/buttons";
import { handleSelectMenu } from "./handlers/select-menus";
import { handleModalSubmit } from "./handlers/modals";

export const registerInteractionHandlers = (client: any) => {
  client.on("interactionCreate", async (interaction: any) => {
    if (interaction.isChatInputCommand()) {
      await handleChatInputCommand(interaction);
    }

    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  });
};