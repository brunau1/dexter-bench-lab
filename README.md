# dexter-bench-lab

A generic kit for **controlled, reproducible performance and resource benchmarks** of containerized systems.

It runs a system under test in Docker under a fixed, open-model load, measures the application *and* every dependency and container around it, repeats each measurement, and compares versions with confidence intervals instead of raw numbers.

> Results are **relative**: version B against version A on the same host class. They are not predictions of production behaviour. See [docs/methodology.md](docs/methodology.md).

## Requirements
- Docker ≥ 24 with the Compose plugin ≥ 2.24.
- git.

Nothing else is installed on the host: the `bench` CLI runs in its own container.

## Usage
```sh
/path/to/dexter-bench-lab/bench --help
```

The quick start is completed together with the example target (`examples/hello-target`).

## License
MIT
