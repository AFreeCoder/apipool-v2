import { main } from './smoke-mvp';

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
