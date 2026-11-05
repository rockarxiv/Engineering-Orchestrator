import type { Db } from "../db/client.js";
import { deviceByTokenHash, deviceHoldsSecretsKey, touchDevice } from "../db/repos/devicesRepo.js";
import type { DeviceDirectory } from "../server/http.js";
import { hashSecret } from "./secrets.js";

/**
 * The organisation's device list, as the server's door reads it
 * (EO-323, `ARCHITECTURE.md`, "Identity").
 *
 * The one seam between "who is knocking" and SQLite. `server/http.ts`
 * knows no more about a device table than it knows about a handler: it
 * is handed this and asks it three questions — who is this token, may
 * this secret collect the organisation's own secrets, and please note
 * that they were here.
 *
 * Built by `startMain`, which is the only place the database and the
 * platform are in the same hand.
 */
export function createDeviceDirectory(db: Db): DeviceDirectory {
  return {
    identify(token) {
      // Hashed, then looked up by an index. There is no scan and no
      // per-row work, which is what makes this affordable on every
      // request — see `secrets.ts` for why a device token is SHA-256
      // where a password is scrypt.
      const identity = deviceByTokenHash(db, hashSecret(token));
      if (identity === undefined) return null;
      return { kind: "device", admin: identity.isAdmin, deviceId: identity.deviceId };
    },
    opensSecrets(presented) {
      // The same hash-then-index lookup `identify` makes, against the
      // other column. A device token never matches it: the two are
      // independent secrets, and that is what keeps the route shut to
      // the renderer a server serves (EO-328, ARCHITECTURE.md, "Secrets").
      return deviceHoldsSecretsKey(db, hashSecret(presented));
    },
    seen(deviceId) {
      touchDevice(db, deviceId);
    },
  };
}
