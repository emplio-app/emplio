// Makes the key pair browser notifications need. Put the two lines in the server's environment.
import { createECDH } from "node:crypto";
const e = createECDH("prime256v1");
e.generateKeys();
console.log(`VAPID_PUBLIC_KEY=${e.getPublicKey().toString("base64url")}\nVAPID_PRIVATE_KEY=${e.getPrivateKey().toString("base64url")}`);
