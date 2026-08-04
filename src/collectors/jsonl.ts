import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export interface JsonlLine {
  readonly raw: string;
  readonly byteOffset: number;
  readonly lineIndex: number;
}

export interface JsonlScanResult {
  /** Byte offset immediately after the last newline-terminated line consumed. */
  bytesConsumed: number;
  linesConsumed: number;
  /** A trailing partial line was present (file is being appended to right now). */
  hadPartialTail: boolean;
}

/**
 * Stream a JSONL file from a byte offset, yielding complete lines only.
 *
 * A partial trailing line (an in-flight append) is deliberately not yielded and
 * not counted as consumed, so the next incremental pass picks it up whole. This
 * is what makes ingestion safe against a live agent writing to the file.
 *
 * Memory is bounded by `highWaterMark` plus the longest single line. Transcript
 * lines can be multi-megabyte (whole-file `content` payloads), so callers must
 * still be careful, but we never hold the whole file.
 */
export async function scanJsonl(
  filePath: string,
  fromByte: number,
  fromLine: number,
  onLine: (line: JsonlLine) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<JsonlScanResult> {
  const stat = fs.statSync(filePath);
  if (fromByte >= stat.size) {
    return { bytesConsumed: fromByte, linesConsumed: fromLine, hadPartialTail: false };
  }

  const stream = createReadStream(filePath, {
    start: fromByte,
    highWaterMark: 1 << 20,
  });

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let absolute = fromByte;
  let lineIndex = fromLine;
  let bytesConsumed = fromByte;
  let hadPartialTail = false;

  try {
    for await (const chunkRaw of stream) {
      if (signal?.aborted) break;
      const chunk = chunkRaw as Buffer<ArrayBufferLike>;
      let buf: Buffer<ArrayBufferLike> = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let searchFrom = 0;

      for (;;) {
        const nl = buf.indexOf(0x0a, searchFrom);
        if (nl === -1) break;
        const lineBuf = buf.subarray(searchFrom, nl);
        const raw = lineBuf.toString('utf8').replace(/\r$/, '');
        const byteOffset = absolute + searchFrom;
        if (raw.length > 0) {
          await onLine({ raw, byteOffset, lineIndex });
        }
        lineIndex++;
        searchFrom = nl + 1;
        bytesConsumed = absolute + searchFrom;
      }

      if (searchFrom > 0) {
        buf = buf.subarray(searchFrom);
        absolute += searchFrom;
      }
      pending = buf;
    }
  } finally {
    stream.destroy();
  }

  if (pending.length > 0) hadPartialTail = true;
  return { bytesConsumed, linesConsumed: lineIndex, hadPartialTail };
}

/**
 * Fingerprint of a file's first bytes. Used to detect that a file was replaced,
 * rotated, or rewritten rather than merely appended to.
 */
export function headFingerprint(filePath: string, bytes = 4096): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return createHash('sha256').update(buf.subarray(0, read)).digest('hex').slice(0, 24);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
