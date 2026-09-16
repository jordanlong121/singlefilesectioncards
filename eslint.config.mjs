import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ files: ["main.ts", "editor-embed.ts", "src/**/*.ts"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: { project: "./tsconfig.json" },
		},
	},
);
