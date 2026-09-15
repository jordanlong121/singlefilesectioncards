// Shared by every *.cases.mjs file: t() for sync cases, ta() for async ones (their
// promises are awaited by report(), which prints the tally and sets the exit code).
export const counts = { pass: 0, fail: 0 };
const pending = [];

export const t = (name, fn) => {
	try {
		fn();
		counts.pass++;
		console.log("ok   " + name);
	} catch (e) {
		counts.fail++;
		console.log("FAIL " + name + "\n     " + e.message);
	}
};

export const ta = (name, fn) => {
	pending.push(
		(async () => {
			try {
				await fn();
				counts.pass++;
				console.log("ok   " + name);
			} catch (e) {
				counts.fail++;
				console.log("FAIL " + name + "\n     " + e.message);
			}
		})(),
	);
};

export const report = async () => {
	await Promise.all(pending);
	console.log(`\n${counts.pass} passed, ${counts.fail} failed`);
	process.exit(counts.fail ? 1 : 0);
};
