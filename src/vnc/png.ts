/**
 * Minimal PNG encoder for RGBA framebuffers: 8-bit RGBA, no filtering, one
 * zlib-compressed IDAT chunk. Uses only `node:zlib` — no native dependencies.
 */
import { deflateSync } from "node:zlib";

export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
	const scanlines = Buffer.alloc((width * 4 + 1) * height);
	for (let row = 0; row < height; row++) {
		const scanlineStart = row * (width * 4 + 1);
		scanlines[scanlineStart] = 0;
		rgba.copy(scanlines, scanlineStart + 1, row * width * 4, (row + 1) * width * 4);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.writeUInt8(8, 8);
	header.writeUInt8(6, 9);
	return Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(data.length + 12);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
	return chunk;
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) {
		crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});
