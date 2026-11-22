import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { AppsError } from "../../types";
import { livekit } from "./index";

type Call = { method: string; url: string; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// records every request and answers with reply(call); anything unanswered is a test bug, not a trip to LiveKit
function stub(reply: (c: Call) => { status?: number; body?: unknown } | undefined = () => ({ body: {} })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c = { method: init.method!, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = reply(c);
    if (!r) throw new Error(`unexpected ${c.method} ${c.url}`);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

const SECRET = "s3cr3t";
const KEY = `wss://myproj.livekit.cloud APIabc ${SECRET}`;
const TWIRP = "https://myproj.livekit.cloud/twirp/livekit.";
// own.run checks the input before running; the app isn't registered yet, so do the same here
const run = (action: string, input: unknown, key = KEY) => {
  const a = livekit.actions[action]!;
  return a.run(a.input.parse(input), key);
};
const fails = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected it to fail");
    },
    (e: AppsError) => e,
  );
// the token's claims, after checking it's signed with the secret
function claims(token: string) {
  const [h, b, sig] = token.replace(/^Bearer /, "").split(".");
  expect(createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url")).toBe(sig!);
  expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
  return JSON.parse(Buffer.from(b!, "base64url").toString());
}

test("a call is a POST to the project's Twirp path, with an empty JSON body and a token signed for just that call", async () => {
  const calls = stub(() => ({ body: { rooms: [] } }));
  expect(await run("list_rooms", {})).toEqual({ rooms: [] });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.url).toBe(`${TWIRP}RoomService/ListRooms`);
  expect(calls[0]!.body).toEqual({});
  expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
  const c = claims(calls[0]!.headers.Authorization!);
  expect(c.iss).toBe("APIabc");
  expect(c.video).toEqual({ roomList: true });
  expect(c.exp - c.nbf).toBe(600);
});

test("room calls are scoped to their room; moves also name the destination", async () => {
  const calls = stub();
  await run("remove_participant", { room: "shop", identity: "ravi" });
  expect(calls[0]!.url).toBe(`${TWIRP}RoomService/RemoveParticipant`);
  expect(calls[0]!.body).toEqual({ room: "shop", identity: "ravi" });
  expect(claims(calls[0]!.headers.Authorization!).video).toEqual({ roomAdmin: true, room: "shop" });
  await run("move_participant", { room: "a", identity: "ravi", destination_room: "b" });
  expect(claims(calls[1]!.headers.Authorization!).video).toEqual({ roomAdmin: true, room: "a", destinationRoom: "b" });
});

test("send_data sends the text as base64 bytes", async () => {
  const calls = stub();
  await run("send_data", { room: "shop", data: "hi", topic: "chat", destination_identities: ["ravi"] });
  expect(calls[0]!.body).toEqual({ room: "shop", data: "aGk=", topic: "chat", destination_identities: ["ravi"] });
});

test("an egress gets roomRecord, and its outputs go as given", async () => {
  const calls = stub(() => ({ body: { egress_id: "EG_1" } }));
  await run("start_room_composite_egress", { room_name: "shop", layout: "speaker", file_outputs: [{ filepath: "r.mp4", s3: { bucket: "b" } }] });
  expect(calls[0]!.url).toBe(`${TWIRP}Egress/StartRoomCompositeEgress`);
  expect(calls[0]!.body).toEqual({ room_name: "shop", layout: "speaker", file_outputs: [{ filepath: "r.mp4", s3: { bucket: "b" } }] });
  expect(claims(calls[0]!.headers.Authorization!).video).toEqual({ roomRecord: true });
});

test("ingress calls get ingressAdmin", async () => {
  const calls = stub();
  await run("create_ingress", { input_type: "RTMP_INPUT", room_name: "live", participant_identity: "obs" });
  expect(calls[0]!.url).toBe(`${TWIRP}Ingress/CreateIngress`);
  expect(calls[0]!.body).toEqual({ input_type: "RTMP_INPUT", room_name: "live", participant_identity: "obs" });
  expect(claims(calls[0]!.headers.Authorization!).video).toEqual({ ingressAdmin: true });
});

test("a trunk's fields are wrapped as the trunk, with the sip admin grant", async () => {
  const calls = stub();
  await run("create_sip_inbound_trunk", { name: "main", numbers: ["+14155552671"] });
  expect(calls[0]!.url).toBe(`${TWIRP}SIP/CreateSIPInboundTrunk`);
  expect(calls[0]!.body).toEqual({ trunk: { name: "main", numbers: ["+14155552671"] } });
  const c = claims(calls[0]!.headers.Authorization!);
  expect(c.sip).toEqual({ admin: true });
  expect(c.video).toBeUndefined();
});

test("updates go as `update` unless a whole `replace` is given", async () => {
  const calls = stub();
  await run("update_sip_dispatch_rule", { sip_dispatch_rule_id: "SDR_1", name: "front desk", trunk_ids: { add: ["ST_2"] } });
  expect(calls[0]!.body).toEqual({ sip_dispatch_rule_id: "SDR_1", update: { name: "front desk", trunk_ids: { add: ["ST_2"] } } });
  await run("update_sip_inbound_trunk", { sip_trunk_id: "ST_1", replace: { name: "x" } });
  expect(calls[1]!.body).toEqual({ sip_trunk_id: "ST_1", replace: { name: "x" } });
});

test("calling out needs sip call; transferring also needs the caller's room", async () => {
  const calls = stub();
  await run("create_sip_participant", { sip_trunk_id: "ST_1", sip_call_to: "+919812345678", room_name: "call-1", ringing_timeout: "30s" });
  expect(calls[0]!.body).toEqual({ sip_trunk_id: "ST_1", sip_call_to: "+919812345678", room_name: "call-1", ringing_timeout: "30s" });
  expect(claims(calls[0]!.headers.Authorization!).sip).toEqual({ call: true });
  await run("transfer_sip_participant", { room_name: "call-1", participant_identity: "sip_1", transfer_to: "tel:+14155552671" });
  const c = claims(calls[1]!.headers.Authorization!);
  expect(c.sip).toEqual({ call: true });
  expect(c.video).toEqual({ roomAdmin: true, room: "call-1" });
});

test("dispatch, phone number and connector calls carry their grants", async () => {
  const calls = stub();
  await run("create_dispatch", { room: "shop", agent_name: "receptionist", metadata: "{}" });
  expect(calls[0]!.url).toBe(`${TWIRP}AgentDispatchService/CreateDispatch`);
  expect(calls[0]!.body).toEqual({ room: "shop", agent_name: "receptionist", metadata: "{}" });
  expect(claims(calls[0]!.headers.Authorization!).video).toEqual({ roomAdmin: true, room: "shop" });
  await run("list_phone_numbers", { limit: 5 });
  expect(calls[1]!.url).toBe(`${TWIRP}PhoneNumberService/ListPhoneNumbers`);
  expect(claims(calls[1]!.headers.Authorization!).sip).toEqual({ admin: true });
  await run("connect_twilio_call", { room_name: "call-2" });
  expect(calls[2]!.url).toBe(`${TWIRP}Connector/ConnectTwilioCall`);
  expect(claims(calls[2]!.headers.Authorization!).video).toEqual({ roomCreate: true, room: "call-2" });
});

test("hosted agents are on agents.<domain>, with the agent admin grant, and secrets go as base64", async () => {
  const calls = stub();
  await run("update_agent_secrets", { agent_id: "CA_1", secrets: [{ name: "K", value: "v" }] });
  expect(calls[0]!.url).toBe("https://agents.livekit.cloud/twirp/livekit.CloudAgent/UpdateAgentSecrets");
  expect(calls[0]!.body).toEqual({ agent_id: "CA_1", secrets: [{ name: "K", value: "dg==" }] });
  expect(claims(calls[0]!.headers.Authorization!).agent).toEqual({ admin: true });
});

test("create_token signs a join token here, without calling LiveKit", async () => {
  const calls = stub(() => undefined);
  const out = (await run("create_token", { identity: "ravi", room: "shop", name: "Ravi", ttl: 3600, can_publish_sources: ["MICROPHONE"], agents: [{ agent_name: "receptionist" }] })) as any;
  expect(calls).toHaveLength(0);
  expect(out.url).toBe("wss://myproj.livekit.cloud");
  expect(out.join_link).toBe(`https://meet.livekit.io/custom?liveKitUrl=wss%3A%2F%2Fmyproj.livekit.cloud&token=${out.token}`);
  const c = claims(out.token);
  expect(c).toMatchObject({ iss: "APIabc", sub: "ravi", name: "Ravi", roomConfig: { agents: [{ agent_name: "receptionist" }] } });
  expect(c.video).toEqual({ roomJoin: true, room: "shop", canPublishSources: ["microphone"] });
  expect(c.exp - c.nbf).toBe(3600);
  expect(livekit.actions.create_token!.readOnly).toBeFalsy();
  expect(livekit.actions.create_token!.description).toContain("SECRET");
});

test("a malformed key is refused before any request; https URLs are taken as they are", async () => {
  const calls = stub(() => ({ body: { rooms: [] } }));
  for (const bad of ["APIabc secret", "myproj.livekit.cloud APIabc secret", "ftp://x APIabc secret"]) {
    const e = await fails(livekit.check(bad));
    expect(e).toBeInstanceOf(AppsError);
    expect(e.message).toContain("Enter the project URL");
  }
  expect(calls).toHaveLength(0);
  await livekit.check(`https://myproj.livekit.cloud/ APIabc ${SECRET}`);
  expect(calls[0]!.url).toBe(`${TWIRP}RoomService/ListRooms`);
});

test("a rejected key asks for reconnecting; other failures carry LiveKit's words", async () => {
  stub(() => ({ status: 401, body: { code: "unauthenticated", msg: "invalid token" } }));
  const e1 = await fails(run("list_rooms", {}));
  expect(e1.expired).toBe(true);
  stub(() => ({ status: 404, body: { code: "not_found", msg: "room not found" } }));
  const e2 = await fails(run("list_participants", { room: "nope" }));
  expect(e2.message).toBe("LiveKit: room not found (404)");
  expect(e2.expired).toBe(false);
});

test("lookups run without asking, everything else asks; every param is described", () => {
  for (const [name, a] of Object.entries(livekit.actions)) {
    expect([name, !!a.readOnly]).toEqual([name, /^(list|get|search)_/.test(name)]);
    const props = (z.toJSONSchema(a.input, { io: "input" }) as any).properties ?? {};
    for (const [field, p] of Object.entries<any>(props)) expect([name, field, !!p.description]).toEqual([name, field, true]);
  }
});
