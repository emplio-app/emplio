import { expect, test } from "bun:test";
import { recordAsk } from "./sandbox";

test("removing, archiving and private/shared changes ask; adding and editing don't", () => {
  expect(recordAsk("clients", ["archive", "Acme", "Foods"])).toBe("Archive the client Acme Foods");
  expect(recordAsk("contacts", ["remove", "Sarah"])).toBe("Archive the contact Sarah");
  expect(recordAsk("meetings", ["delete", "Kickoff"])).toBe("Delete the meeting Kickoff");
  expect(recordAsk("processes", ["remove", "onboarding"])).toBe("Delete the process onboarding");
  expect(recordAsk("processes", ["private", "onboarding", "no"])).toBe("Share the process onboarding with everyone");
  expect(recordAsk("services", ["update", "Audit", "--private", "yes"])).toBe("Make the service Audit private");
  expect(recordAsk("projects", ["update", "Portal", "--private", "no"])).toBe("Share the project Portal with everyone");
  expect(recordAsk("clients", ["stages", "remove", "Lost"])).toBe("Remove the client stage Lost");
  expect(recordAsk("contacts", ["fields", "remove", "Birthday"])).toBe("Remove the contact field Birthday");
  expect(recordAsk("clients", ["add", "Acme", "--private"])).toBeNull();
  expect(recordAsk("clients", ["update", "Acme", "--stage", "Won"])).toBeNull();
  expect(recordAsk("processes", ["start", "onboarding"])).toBeNull();
});
