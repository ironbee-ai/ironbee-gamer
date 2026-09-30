// @ts-check
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsparser = require("@typescript-eslint/parser");

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
  {
    // The research prototype is kept as it was; the built output and the library are not source.
    ignores: ["research/**", "dist/**", "library/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // Enforce 4-space indentation
      indent: ["error", 4, { SwitchCase: 1 }],

      // Always require curly braces for if/else/for/while
      curly: ["error", "all"],

      // Double quotes (a string that contains one may use single quotes) and semicolons
      quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
      semi: ["error", "always"],

      // Private members without an underscore prefix
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "memberLike", modifiers: ["private"], format: null, leadingUnderscore: "forbid" },
      ],

      // Require explicit return types on functions
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: false,
          allowTypedFunctionExpressions: false,
          allowHigherOrderFunctions: false,
        },
      ],

      // Require type annotations on variables, parameters, and properties
      "@typescript-eslint/typedef": [
        "error",
        {
          arrayDestructuring: false,
          arrowParameter: true,
          memberVariableDeclaration: true,
          objectDestructuring: false,
          parameter: true,
          propertyDeclaration: true,
          variableDeclaration: true,
          variableDeclarationIgnoreFunction: false,
        },
      ],
    },
  },
];
