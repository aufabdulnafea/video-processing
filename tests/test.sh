curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "input": {
      "bucket": "hiplando-public",
      "key": "tmp/bvD98ay5M3YxQDRvSrNhd34CZNrcNiZL-71ca6125-c375-4397-a458-3a6a704ef7d8-1785868101843.mov"
    },
    "output": {
      "bucket": "hiplando-public",
      "prefix": "processed-microservice/input_video"
    },
    "customVariants": [
      { "name": "720p", "targetMaxDimension": 720, "bitrate": "2500k", "bandwidth": 2800000 },
      { "name": "480p", "targetMaxDimension": 480, "bitrate": "1000k", "bandwidth": 1200000 }
    ]
  }'