# Rehab Utilization Review — Vercel build (v81 — speed optimized)

This build is converted from the supplied Netlify deployment to Vercel.

## Deploy
1. Import/upload this project to Vercel.
2. In Vercel Project Settings → Environment Variables, add `OPENAI_API_KEY` with your OpenAI API key.
3. Redeploy after adding/changing the environment variable.
4. The browser calls `/api/analyze`, implemented by `api/analyze.js`.

The app keeps the existing local PDF extraction, patient review logic, streaming OpenAI response handling, and privacy-oriented no-store behavior.


## v81 speed changes
- One AI call is the default path for charts up to ~100k cleaned characters.
- No automatic retry delay on the normal analysis call.
- Larger fallback chunks and up to three fallback evidence requests concurrently.
- Up to three patients concurrently on desktop; two on iPhone/iPad.
- Patient output target reduced while preserving the existing report sections.
- Facility snapshot still runs only after patient reports are rendered.
