// Stands in for Emplio Cloud's client parts (cloud/frontend/client.tsx) in a copy without the private cloud/ folder:
// no billing, no analytics. Emplio is never paused.
export const Analytics = () => null;
export const CreditMeter = () => null;
export const BillingMenuItem = (_: { role: string | undefined }) => null;
export const useCreditStatus = () => ({ data: undefined as { paused: boolean } | undefined });
// where a new business goes once it's set up, instead of its chat; null for the chat
export const afterWelcome = async (_country: string, _chat: string): Promise<string | null> => null;
export const DangerZone = () => null;
export const pausedNote = (message: string) => message;
