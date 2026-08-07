// Minimal asar reader: pull one file out of an .asar archive.
import fs from "fs";
const [archive, want] = process.argv.slice(2);
const buf = fs.readFileSync(archive);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString("utf8"));
const base = 16 + headerSize;
const walk = (node, path) => {
	for (const [name, child] of Object.entries(node.files ?? {})) {
		const p = path ? `${path}/${name}` : name;
		if (child.files) walk(child, p);
		else if (p === want || name === want) {
			const off = Number(child.offset), size = Number(child.size);
			fs.writeFileSync(name, buf.subarray(base + off, base + off + size));
			console.log("extracted", p, size, "bytes");
		}
	}
};
walk(header, "");
