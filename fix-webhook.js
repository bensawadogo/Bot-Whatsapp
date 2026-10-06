const fs = require("fs");
const content = fs.readFileSync("C:\\BOT-WHATSAPP\\src\\shared\\webhook.controller.ts", "utf8");
const fixed = content
  .replace(/â€"/g, "—")
  .replace(/Ã©/g, "é")
  .replace(/Ã¨/g, "è")
  .replace(/Ã§/g, "ç")
  .replace(/Ã´/g, "ô")
  .replace(/Ã¢/g, "â")
  .replace(/Ã®/g, "î")
  .replace(/Ã¹/g, "ù")
  .replace(/Ã¼/g, "ü")
  .replace(/Ã¯/g, "ï")
  .replace(/Ã«/g, "ë")
  .replace(/Ã /g, "à")
  .replace(/â€¢/g, "•")
  .replace(/â€™/g, "'")
  .replace(/â€œ/g, '"')
  .replace(/â€/g, '"')
  .replace(/â€¦/g, "…");
const lines = fixed.split("\n");
let i = lines.length - 1;
while (i >= 0 && lines[i].trim() === "") i--;
if (lines[i].trim() === "});") {
  let j = i - 1;
  while (j >= 0 && lines[j].trim() === "") j--;
  if (j >= 0 && lines[j].trim() === "});") {
    lines.splice(j, 1);
  }
}
fs.writeFileSync("C:\\BOT-WHATSAPP\\src\\shared\\webhook.controller.ts", lines.join("\n"), "utf8");
console.log("Fixed");
