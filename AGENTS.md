# Repository task instructions

## Capstone / OpenSim data handoff

For requests such as “캡스톤 전달 데이터 만들어줘”, “예전에 준 데이터처럼”,
or another case in the established capstone workflow:

1. Read [docs/CAPSTONE_HANDOFF.md](docs/CAPSTONE_HANDOFF.md).
2. Read `work/capstone-handoff-registry.json` if present. It is private local state,
   not a file to commit or include in a delivery.
3. Resolve the requested case from the conversation, registry and saved analysis
   records before asking for a path. Do not ask the user to repeat known choices.
4. Follow the documented delivery contract; verify and return an existing matching
   package when possible. Do not rerun inference or alter source masks for a handoff.

Keep patient/run identities, original scans, voxel masks, private source audit
records and generated case packages out of Git and public assets.
