const fs = require('fs');
const acorn = require('acorn');
const jsx = require('acorn-jsx');

const code = fs.readFileSync('frontend/src/App.jsx', 'utf8');

try {
  acorn.Parser.extend(jsx()).parse(code, { sourceType: 'module', ecmaVersion: 2020 });
  console.log("SUCCESS NO PARSE ERRORS");
} catch (e) {
  console.log("PARSE ERROR AT:", e.loc);
  console.log("Message:", e.message);
}
