# Blockchain API Response Time Benchmark

A performant Node.js tool to benchmark and compare response times between blockchain data APIs.

## APIs Tested

- **Moralis** - ERC-20 token balances endpoint
- **Glacier (Avalanche)** - ERC-20 balances via Data API

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your API keys:
```env
MORALIS_API_KEY=your_moralis_api_key_here
GLACIER_API_KEY=your_glacier_api_key_here
```

3. (Optional) Configure benchmark parameters:
```env
ITERATIONS=50
CONCURRENCY=5
TEST_ADDRESS=0xcB1C1FdE09f811B294172696404e88E658659905
```

## Usage

Run the benchmark:
```bash
npm start
```

Run a quick test with fewer iterations:
```bash
npm test
```

## Metrics

The benchmark measures and reports:

| Metric | Description |
|--------|-------------|
| Min | Fastest response time |
| Max | Slowest response time |
| Average | Mean response time |
| Median | 50th percentile |
| P90 | 90th percentile |
| P95 | 95th percentile |
| P99 | 99th percentile |

## Requirements

- Node.js 18+ (uses native fetch)
- API keys for the services you want to test

## Get API Keys

- **Moralis**: https://admin.moralis.io/
- **Glacier**: https://avacloud.io/

