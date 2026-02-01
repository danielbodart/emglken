#!/bin/bash
# Simple HTTP server for testing JSPI
#
# Usage: ./serve.sh
# Then open http://localhost:8080 in Chrome

echo "Starting HTTP server on http://localhost:8080"
echo "Open this URL in Chrome 131+ (or enable chrome://flags/#enable-experimental-webassembly-jspi)"
echo ""

# Try python3 first, then python
if command -v python3 &> /dev/null; then
    python3 -m http.server 8080
elif command -v python &> /dev/null; then
    python -m http.server 8080
else
    echo "Python not found. Install Python or use another HTTP server."
    echo "Alternative: npx serve -p 8080"
    exit 1
fi
