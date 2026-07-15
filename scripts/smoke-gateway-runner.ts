import { main } from './smoke-gateway';

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
