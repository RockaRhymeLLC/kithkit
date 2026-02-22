# Weather Check Reference

## API Endpoints

- Current weather: `GET /data/2.5/weather?q={city}`
- 5-day forecast: `GET /data/2.5/forecast?q={city}`

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| api_key | credential | yes | — | OpenWeather API key |
| units | enum | no | metric | Temperature units (metric/imperial) |
