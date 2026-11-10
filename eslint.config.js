// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // Hermes 250829098.0.10 builds the wrong object for an object literal
    // holding an await when it is a branch of `?:`, on device only.
    plugins: { hermes: { rules: { 'conditional-object-await': {
      create: (context) => ({
        AwaitExpression(node) {
          for (let n = node; n.parent && !n.type.includes('Function'); n = n.parent) {
            if (n.type === 'ObjectExpression' && n.parent.type === 'ConditionalExpression') {
              context.report({ node, message: 'Hermes miscompiles an await inside an object literal that is a branch of ?:. Await into a variable first.' });
              return;
            }
          }
        },
      }),
    } } } },
    rules: { 'hermes/conditional-object-await': 'error' },
  },
]);
