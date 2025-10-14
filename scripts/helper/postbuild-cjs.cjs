const { writeFile } = require("fs/promises");
const path = require("path");
(async () => {
  await writeFile(path.join("dist", "package.json"),
    JSON.stringify({ type: "commonjs" }) + "\n");
})();
