// Minimal schemastery stand-in. Config is declared, not executed, by the smoke
// test; a chainable no-op builder is enough to prove the module loads and
// `apply` receives a plain object.
function builder() {
  const node = {
    default(value) {
      node.defaultValue = value;
      return node;
    },
    description() {
      return node;
    },
    step() {
      return node;
    },
    min() {
      return node;
    },
    max() {
      return node;
    },
    volatile() {
      return node;
    },
  };
  return node;
}

const z = {
  object(shape) {
    return { type: "object", shape };
  },
  string: builder,
  number: builder,
  boolean: builder,
};

export default z;
