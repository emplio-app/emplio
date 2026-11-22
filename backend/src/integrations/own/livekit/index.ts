// LiveKit on the business's own project: every server API (Twirp) call — rooms, recording and streaming,
// ingress, phone calls (SIP, phone numbers, WhatsApp/Twilio), agent dispatch and hosted agents — plus
// create_token, a join token signed here. COVERAGE.md lists what's where.
import type { OwnApp } from "../index";
import { parseKey } from "./client";
import { cloudAgentActions } from "./cloud_agents";
import { connectorActions } from "./connector";
import { dispatchActions } from "./dispatch";
import { egressActions } from "./egress";
import { ingressActions } from "./ingress";
import { phoneNumberActions } from "./phone_numbers";
import { roomActions } from "./room";
import { sipActions } from "./sip";

const actions = { ...roomActions, ...egressActions, ...ingressActions, ...sipActions, ...phoneNumberActions, ...connectorActions, ...dispatchActions, ...cloudAgentActions };

export const livekit: OwnApp = {
  app: "livekit",
  name: "LiveKit",
  logo: "/logos/livekit.png",
  keyField: {
    label: "Project URL, API key and secret",
    help: "In cloud.livekit.io → Settings → Keys, make a key and copy its project URL, API key and API secret.",
    placeholder: "wss://myproj.livekit.cloud APIxxxx secretxxxx",
    sep: " ",
    parts: [{label:"Project URL",placeholder:"wss://myproj.livekit.cloud"},{label:"API key",placeholder:"APIxxxx"},{label:"API secret",secret:true,placeholder:"secretxxxx"}],
  },
  // a malformed key fails here; a wrong key or secret gets a 401, which marks the connection for reconnecting
  async check(key) {
    parseKey(key);
    await actions.list_rooms.run({}, key);
  },
  actions,
};
