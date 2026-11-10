/**
 * One provider call, in its own process, so env.ts resolves once per case
 * exactly as it does at boot. Prints a JSON result on stdout.
 *
 *   node -> tsx test/_probe.mjs image '{"prompt":"a cat"}'
 */
import { generateImage } from '../src/providers/image.ts';
import { synthesize, transcribe, mintRealtimeSecret } from '../src/providers/speech.ts';

const [kind, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) : {};

const MARK = '@@PROBE@@';
/** env.ts writes boot notes to stdout; a marker keeps the JSON unambiguous. */
function out(value) {
  process.stdout.write(MARK + JSON.stringify({ ok: true, value }, (_k, v) => (v?.type === 'Buffer' ? { buffer: Buffer.from(v.data).toString('base64') } : v)) + '\n');
}

try {
  switch (kind) {
    case 'image': {
      const images = await generateImage(args.prompt, args.opts);
      out(images);
      break;
    }
    case 'tts': {
      const r = await synthesize(args.text, args.opts);
      out({ bytes: r.bytes.toString('base64'), mime: r.mime });
      break;
    }
    case 'stt': {
      const r = await transcribe(Buffer.from(args.audioB64, 'base64'), args.opts);
      out(r);
      break;
    }
    case 'realtime': {
      out(await mintRealtimeSecret());
      break;
    }
    default:
      throw new Error(`unknown probe: ${kind}`);
  }
} catch (e) {
  process.stdout.write(MARK + JSON.stringify({ ok: false, error: String(e?.message ?? e), status: e?.status, capability: e?.capability }) + '\n');
  process.exitCode = 0;
}
