// One-off sender: npm run send -- "text" [+15551234567]
// Defaults to the owner's number (PHOTON_OWNER_PHONE). Prints only the outcome, never credentials.
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { env } from "./env.ts";

const text =
  process.argv[2] ??
  "Retrofit Radar test: your agent can text you now. Reply with anything to test two-way texting.";
const to = process.argv[3] ?? env("PHOTON_OWNER_PHONE");

const app = await Spectrum({
  projectId: env("SPECTRUM_PROJECT_ID"),
  projectSecret: env("SPECTRUM_PROJECT_SECRET"),
  providers: [imessage.config()],
});

try {
  const im = imessage(app);
  const space = await im.space.create(await im.user(to));
  await space.send(text);
  console.log(JSON.stringify({ status: "sent", line: space.phone, type: space.type }));
} catch (err) {
  const e = err as Error;
  console.error(JSON.stringify({ status: "error", name: e?.name, message: String(e?.message ?? err).slice(0, 400) }));
  process.exitCode = 1;
} finally {
  await app.stop();
}
