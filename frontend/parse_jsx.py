import re
with open("src/App.jsx", "r") as f:
    text = f.read()

# simple stack to find unmatched <div> / </div>
lines = text.split("\n")
stack = []
for i, line in enumerate(lines):
    # ignore comments for simplicity
    if "/*" in line or "//" in line: continue
    
    opens = re.findall(r'<div\b[^>]*>', line)
    closes = re.findall(r'</div>', line)
    for _ in opens: stack.append(i+1)
    for _ in closes:
        if stack: stack.pop()
        else: print(f"Unmatched </div> at line {i+1}")
print("Unclosed <div> starts at lines:", stack)
