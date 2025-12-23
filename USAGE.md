FFmpeg Assembler — Usage Notes

Cleanup and testing

- Automatic cleanup: the service removes `tmp/` folders older than 60 minutes every 30 minutes.
- Manual cleanup: GET `/cleanup` will run a cleanup and return the number of removed folders.
- Test script: `test_request.js` posts 3 random images and a sample MP3 to the service.

Run the test (after installing dependencies):

```bash
node test_request.js
```

n8n integration reminder

- Configure an HTTP Request node in n8n that POSTs JSON to `http://<host>:3000/assemble` with body:
  {
    "images": ["https://...", "https://..."],
    "audio": "https://...",
    "durationPerImage": 2
  }
- Use the returned `url` field to continue upload to socials (YouTube/TikTok/IG).

Security

- This service is intentionally simple. If you deploy it publicly, protect the endpoints with an API key or other auth, and consider cleaning tmp files to object storage instead of local disk.
