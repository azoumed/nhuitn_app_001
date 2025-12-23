const fetch = require('node-fetch');

async function test() {
  const res = await fetch('http://localhost:3000/assemble', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      images: [
        'https://picsum.photos/720/1280?random=1',
        'https://picsum.photos/720/1280?random=2',
        'https://picsum.photos/720/1280?random=3'
      ],
      audio: 'https://file-examples.com/wp-content/uploads/2017/11/file_example_MP3_700KB.mp3',
      durationPerImage: 2
    })
  });
  const j = await res.json();
  console.log('response:', j);
}

test().catch(e => console.error(e));
