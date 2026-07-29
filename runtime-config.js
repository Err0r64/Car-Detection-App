function parseConfigJson(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Configuration JSON must be text.');
  }
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

module.exports = {
  parseConfigJson,
};
