Duplication Tracking (local)

This service includes a simple file-based tracker to avoid republishing the same keyword.

Endpoints

- GET /check?key=<keyword>
  - Returns: { exists: true|false, record: {...} }
  - Example: `GET http://localhost:3000/check?key=how%20to%20bake%20bread`

- POST /record
  - Body JSON: { key, title, url, platform }
  - Returns: { success: true, record }
  - Example body: {"key":"how to bake bread","title":"How to Bake Bread","url":"http://...","platform":"youtube"}

n8n integration example

- Before running the flow for a keyword, add an HTTP Request node to call `/check` with the keyword.
- If `exists:true`, stop the flow or log and skip.
- After successful upload, call `/record` with the keyword, title and the published URL.

Example n8n HTTP Request (check)
- Method: GET
- URL: `http://localhost:3000/check?key={{ $json.keyword }}`
- Use the response `exists` to conditionally stop or continue.

Example n8n HTTP Request (record)
- Method: POST
- URL: `http://localhost:3000/record`
- Body (JSON):
  {
    "key": "={{ $json.keyword }}",
    "title": "={{ $json.title }}",
    "url": "={{ $json.videoUrl }}",
    "platform": "youtube"
  }

Notes
- This is a simple local tracker saved to `published.json` in the service folder. For production use, replace with Airtable, Google Sheets, or a persistent database.
- If you want, I can add direct Airtable or Google Sheets support (requires API keys and setup).