// Utilities for the standalone player.html#... level format.

function cleanHashToken(value) {
  const text = String(value || '');
  let token = '';
  let started = false;

  for (const ch of text) {
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_') {
      token += ch;
      started = true;
    } else if (/\s/.test(ch)) {
      continue;
    } else if (started) {
      break;
    }
  }

  return token;
}

export function extractBakedLevelHash(value) {
  const text = String(value || '').trim();
  if (!text) return '';

  let source = text;
  const hashIndex = text.indexOf('#');
  if (hashIndex !== -1) {
    source = text.slice(hashIndex + 1);
  } else if (/^(https?:)?\/\//i.test(text) || /player\.html/i.test(text)) {
    return '';
  }

  try {
    source = decodeURIComponent(source);
  } catch {
    // Keep the raw hash if it was not URI-encoded.
  }

  return cleanHashToken(source);
}

export async function decodeBakedLevelHash(hash) {
  const token = extractBakedLevelHash(hash);
  if (!token) {
    throw new Error('Paste a baked player link with a # hash.');
  }
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot decode baked player links.');
  }

  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  let binary = '';
  try {
    binary = atob(padded);
  } catch {
    throw new Error('The baked link hash is not valid base64 data.');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  try {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    const writeTask = (async () => {
      await writer.write(bytes);
      await writer.close();
    })();
    const decompressed = await new Response(ds.readable).arrayBuffer();
    await writeTask;
    return new TextDecoder().decode(decompressed);
  } catch {
    throw new Error('The baked link hash could not be decompressed.');
  }
}

export async function decodeBakedLevelJsonFromText(value) {
  return decodeBakedLevelHash(extractBakedLevelHash(value));
}
