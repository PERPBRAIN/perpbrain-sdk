/** WebCrypto SHA-256 receipt check shared by the verify page and the results card. */

export const STATEMENT = "verified and reproducible";
export const KIND = "perpbrain.sim-receipt";

export async function checkReceipt(receiptText, manifestBytes, inputsBytes) {
  const problems = [];
  let receipt;
  try {
    receipt = JSON.parse(receiptText);
  } catch {
    return { status: "MISMATCH", mismatches: ["receipt json mismatch"] };
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { status: "MISMATCH", mismatches: ["receipt mismatch"] };
  }
  if (
    typeof receipt.version !== "number" ||
    !Number.isInteger(receipt.version) ||
    (receipt.version !== 1 && receipt.version !== 2)
  ) {
    problems.push("version mismatch");
  }
  if (receipt.kind !== KIND) problems.push("kind mismatch");
  if (receipt.label !== "SIMULATED") problems.push("label mismatch");
  if (receipt.statement !== STATEMENT) problems.push("statement mismatch");
  if (!receipt.limits || typeof receipt.limits !== "object" || Array.isArray(receipt.limits)) {
    problems.push("limits mismatch");
  } else if ((await sha256Text(canonical(receipt.limits))) !== receipt.limits_hash) {
    problems.push("limits_hash mismatch");
  }
  if (!Array.isArray(receipt.market_snapshot)) {
    problems.push("market_snapshot mismatch");
  } else if ((await sha256Text(canonical(receipt.market_snapshot))) !== receipt.market_snapshot_id) {
    problems.push("market_snapshot_id mismatch");
  }
  if (receipt.inputs !== undefined) {
    const encoded = new TextEncoder().encode(`${canonical(receipt.inputs)}\n`);
    if ((await sha256Bytes(encoded)) !== receipt.data_snapshot_id) problems.push("data_snapshot_id mismatch");
  }
  if ((await sha256Text(canonical(receipt.result))) !== receipt.result_sha256) problems.push("result_sha256 mismatch");
  const manifestHash = await sha256Bytes(manifestBytes);
  if (manifestHash !== receipt.manifest_sha256) problems.push("manifest_sha256 mismatch");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    problems.push("manifest json mismatch");
    return { status: "MISMATCH", mismatches: problems };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    problems.push("manifest mismatch");
  } else {
    for (const key of ["data_snapshot_id", "limits_hash", "market_snapshot_id", "result_sha256"]) {
      if (manifest[key] !== receipt[key]) problems.push(`manifest ${key} mismatch`);
    }
  }
  if (inputsBytes && (await sha256Bytes(inputsBytes)) !== receipt.data_snapshot_id) {
    problems.push("data_snapshot_id mismatch");
  }
  return { status: problems.length ? "MISMATCH" : "VERIFIED", mismatches: problems };
}

export function canonical(value) {
  return JSON.stringify(sortValue(value));
}

export function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
    return sorted;
  }
  return value;
}

export async function sha256Text(text) {
  return sha256Bytes(new TextEncoder().encode(text));
}

export async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", exactBytes(bytes));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function exactBytes(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(view);
}
