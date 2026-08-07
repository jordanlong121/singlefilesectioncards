import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ files: ["main.ts"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: { project: "./tsconfig.json" },
		},
	},
);
