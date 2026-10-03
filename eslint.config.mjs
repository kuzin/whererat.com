import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // All <img> usages in this project are local OpenMoji SVGs that don't benefit
      // from next/image optimisation (SVGs are served as-is; no format conversion).
      "@next/next/no-img-element": "off",
      // Honour the _underscore convention for intentionally-unused vars/args.
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
      // WCAG AA accessibility rules (jsx-a11y is bundled with eslint-config-next)
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/interactive-supports-focus": "warn",
      "jsx-a11y/label-has-associated-control": ["warn", { depth: 3 }],
      "jsx-a11y/no-redundant-roles": "warn",
      "jsx-a11y/role-has-required-aria-props": "error",
    },
  },
  {
    // Playwright fixtures hand tests a callback literally named `use`, which the
    // React hooks rule mistakes for a hook.
    files: ["e2e/**/*.ts"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "apps/mobile/**",
    "playwright-report/**",
    "test-results/**",
    ".e2e/**",
  ]),
]);

export default eslintConfig;
