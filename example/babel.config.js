const path = require('path');
const { getConfig } = require('react-native-builder-bob/babel-config');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');

const config = getConfig(
  {
    presets: ['babel-preset-expo'],
  },
  { root, pkg }
);

/**
 * `@expo/metro-config`'s babel-transformer builds its cache key by calling
 * `loadPartialConfigSync()` without a `filename`. Babel throws on string/RegExp
 * `include`/`exclude` patterns when there is no filename to match against, and
 * that throw happens inside Metro's `Transformer` constructor, so the transformer
 * is never assigned and every bundle fails with the misleading
 * "Cannot read properties of undefined (reading 'transformFile')".
 *
 * Babel checks function patterns before it requires a filename, so express
 * builder-bob's source override as a predicate. It mirrors Babel's own
 * directory-string semantics (`^<dir>(?:/|$)`): the directory itself or anything
 * beneath it.
 */
module.exports = {
  ...config,
  overrides: config.overrides?.map((override) => {
    if (typeof override.include !== 'string') {
      return override;
    }

    const include = override.include;

    return {
      ...override,
      include: (filename) =>
        typeof filename === 'string' &&
        (filename === include || filename.startsWith(include + path.sep)),
    };
  }),
};
