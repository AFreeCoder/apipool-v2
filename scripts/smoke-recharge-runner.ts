import { main } from './smoke-recharge';

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
