// Cards customers saved with PayU for faster checkout. Listing and removing only: saving or editing a card means
// handling full card numbers, which stays with PayU's checkout (COVERAGE.md).
import { z } from "zod";
import type { OwnAction } from "../index";
import { cmd, creds } from "./client";

const userId = z.string().min(1).describe("The customer's id on the business's own site or app, the one used when their card was saved");
// PayU wants "<merchant key>:<customer id>"
const user = (secret: string, id: string) => `${creds(secret).key}:${id}`;

const withUser = (name: string, description: string, input: z.ZodObject, vars: (i: any) => unknown[], readOnly: boolean): OwnAction => {
  const base = cmd(name, description, input, vars, readOnly);
  return { ...base, run: (i: any, key: string) => base.run({ ...i, user: user(key, i.user_id) }, key) };
};

export const cardActions: Record<string, OwnAction> = {
  list_saved_cards: withUser("get_user_cards", "The cards a customer has saved with PayU (masked numbers, card type, bank, token), for saved-card checkout.", z.object({ user_id: userId }), (i) => [i.user], true),
  list_tokenized_cards: withUser(
    "get_payment_instrument",
    "The cards a customer has saved as network or issuer tokens (RBI card-on-file tokenisation), masked, with each card's token.",
    z.object({ user_id: userId }),
    (i) => [i.user],
    true,
  ),
  delete_saved_card: withUser(
    "delete_payment_instrument",
    "Remove a saved card from a customer's account, e.g. when they ask for it to be forgotten.",
    z.object({
      user_id: userId,
      card_token: z.string().min(1).describe("The card's cardToken, from payu.list_saved_cards or payu.list_tokenized_cards"),
      network_token: z.string().optional().describe("The card's network token, if it has one"),
      issuer_token: z.string().optional().describe("The card's issuer token, if it has one"),
    }),
    (i) => [i.user, i.card_token, i.network_token, i.issuer_token],
    false,
  ),
};
