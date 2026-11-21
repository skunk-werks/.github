// Runs the CLA workflow's github-script body against a fake GitHub API, one case per outcome.
const WF = process.argv[2] ?? "";
const doc = Bun.YAML.parse(await Bun.file(WF).text()) as {
	jobs: { cla: { steps: { with: { script: string } }[] } };
};
const body = doc.jobs.cla.steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const run = new AsyncFunction("github", "context", "core", body);

type Files = Record<string, Record<string, string>>; // sha -> path -> content
interface Case {
	name: string;
	author: string;
	type?: string;
	files: Files;
	commits: { sha: string; login: string; patch: Record<string, string> }[];
	expect: "pass" | "fail";
}
const b64 = (s: string) => Buffer.from(s).toString("base64");
const LIC = { LICENSE: "All rights reserved." };
const SIGN = (l: string) => `- @${l}: I agree that my contributions to this repository are made under LICENSE.`;

async function check(c: Case): Promise<{ result: "pass" | "fail"; msg: string }> {
	let failed = "";
	const logs: string[] = [];
	const github = {
		rest: {
			repos: {
				getContent: async ({ path, ref }: { path: string; ref: string }) => {
					const v = c.files[ref]?.[path];
					if (v === undefined) throw Object.assign(new Error("nf"), { status: 404 });
					return { data: { content: b64(v) } };
				},
				getCommit: async ({ ref }: { ref: string }) => {
					const k = c.commits.find((x) => x.sha === ref);
					return {
						data: {
							files: Object.entries(k?.patch ?? {}).map(([filename, patch]) => ({ filename, patch })),
						},
					};
				},
			},
			pulls: { listCommits: "listCommits" },
		},
		paginate: async () => c.commits.map((k) => ({ sha: k.sha, author: { login: k.login } })),
	};
	const context = {
		repo: { owner: "skunk-werks", repo: "x" },
		payload: {
			pull_request: { number: 1, user: { login: c.author, type: c.type ?? "User" }, base: { sha: "base" }, head: { sha: "head" } },
		},
	};
	const core = { info: (m: string) => logs.push(m), setFailed: (m: string) => (failed = m) };
	process.env.OWNERS = "ziadsawalha icanhasjonas";
	process.env.LICENSE_PATH = "LICENSE";
	await run(github, context, core);
	return { result: failed ? "fail" : "pass", msg: failed || logs.join(" ") };
}

const cases: Case[] = [
	{ name: "owner passes", author: "icanhasjonas", files: {}, commits: [], expect: "pass" },
	{ name: "bot passes", author: "dependabot[bot]", type: "Bot", files: {}, commits: [], expect: "pass" },
	{
		name: "no LICENSE fails",
		author: "alice",
		files: { base: {}, head: { "CONTRIBUTORS.md": SIGN("alice") } },
		commits: [],
		expect: "fail",
	},
	{
		name: "signed on base passes",
		author: "alice",
		files: { base: { ...LIC, "CONTRIBUTORS.md": `## Signed\n${SIGN("alice")}\n` }, head: {} },
		commits: [],
		expect: "pass",
	},
	{
		name: "unsigned fails",
		author: "alice",
		files: { base: { ...LIC, "CONTRIBUTORS.md": "## Signed\n" }, head: { "CONTRIBUTORS.md": "## Signed\n" } },
		commits: [{ sha: "c1", login: "alice", patch: { "src/a.ts": "+x" } }],
		expect: "fail",
	},
	{
		name: "signed in the PR by the author passes",
		author: "alice",
		files: { base: { ...LIC, "CONTRIBUTORS.md": "## Signed\n" }, head: { "CONTRIBUTORS.md": `## Signed\n${SIGN("alice")}\n` } },
		commits: [
			{ sha: "c1", login: "alice", patch: { "src/a.ts": "+x" } },
			{ sha: "c2", login: "alice", patch: { "CONTRIBUTORS.md": `@@ -1 +1,2 @@\n ## Signed\n+${SIGN("alice")}` } },
		],
		expect: "pass",
	},
	{
		name: "line added by someone else fails",
		author: "alice",
		files: { base: { ...LIC, "CONTRIBUTORS.md": "## Signed\n" }, head: { "CONTRIBUTORS.md": `## Signed\n${SIGN("alice")}\n` } },
		commits: [{ sha: "c2", login: "mallory", patch: { "CONTRIBUTORS.md": `+${SIGN("alice")}` } }],
		expect: "fail",
	},
	{
		name: "another person's line does not count",
		author: "alice",
		files: { base: { ...LIC, "CONTRIBUTORS.md": `## Signed\n${SIGN("alicex")}\n` }, head: { "CONTRIBUTORS.md": `## Signed\n${SIGN("alicex")}\n` } },
		commits: [],
		expect: "fail",
	},
	{
		name: "a removed line in the patch does not count",
		author: "alice",
		files: { base: { ...LIC, "CONTRIBUTORS.md": "## Signed\n" }, head: { "CONTRIBUTORS.md": `## Signed\n${SIGN("alice")}\n` } },
		commits: [{ sha: "c3", login: "alice", patch: { "CONTRIBUTORS.md": `-${SIGN("alice")}` } }],
		expect: "fail",
	},
];

let bad = 0;
for (const c of cases) {
	const r = await check(c);
	const ok = r.result === c.expect;
	if (!ok) bad++;
	console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: ${r.result}${ok ? "" : ` (${r.msg})`}`);
}
console.log(`${cases.length - bad} of ${cases.length} passed`);
process.exit(bad ? 1 : 0);
