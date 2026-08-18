import { main } from './smoke-image';

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
