// Run the app's TypeScript directly with Node's test runner and the existing compiler.
const fs = require("node:fs")
const ts = require("typescript")
const Module = require("node:module")
const path = require("node:path")

// Match the @/* alias from tsconfig.json when loading app components.
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (id, ...args) {
  return resolveFilename.call(this, id.startsWith("@/") ? path.resolve(__dirname, "..", id.slice(2)) : id, ...args)
}

for (const extension of [".ts", ".tsx"]) {
  require.extensions[extension] = (module, filename) => {
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        target: ts.ScriptTarget.ES2017,
      },
      fileName: filename,
    })
    module._compile(outputText, filename)
  }
}
