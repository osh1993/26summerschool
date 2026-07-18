// 내부 인증용 비밀번호의 SHA-256 hex(소문자)를 출력한다.
// 비밀번호를 명령 인자로 넣으면 셸 기록에 남으므로, 표준입력으로 받는다.
// 사용: node scripts/hash-password.mjs   → 프롬프트에 비밀번호 입력 후 Enter
// 결과 hex를 Apps Script Script Property `CAMP_INTERNAL_PW_HASH`에 넣는다.
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, output: process.stderr });
rl.question("내부 인증 비밀번호 입력(화면에 보임): ", (pw) => {
  const hex = createHash("sha256").update(String(pw), "utf8").digest("hex");
  // hex만 표준출력으로 내보내 파이프/복사에 쓰기 쉽게 한다.
  process.stdout.write(hex + "\n");
  rl.close();
});
