// Apps Script 웹앱을 배포한 뒤 아래 주소를 입력하세요. 이 URL들은 비밀키가 아닙니다.
// - apiUrl: 공개(무인증) 스냅샷. /exec?view=public 주소. Apps Script는 공개 허용 필드만 반환해야 합니다.
// - internalApiUrl: 인증 내부 뷰 + 관리자 설정 저장. /exec 주소(같은 배포). 브라우저가 {user, password}를 POST하면
//   Apps Script가 서버에서 검증한 뒤에만 실명 포함 내부 스냅샷을 반환합니다.
//   로그인 성공 시 발급되는 쓰기 토큰으로 "설정" 탭에서 설정/매핑/조·방·차량을 편집합니다
//   (Script Property CAMP_INTERNAL_TOKEN_SECRET이 설정된 경우에만 저장 활성화).
//   비밀번호·토큰 비밀키는 절대 이 파일에 넣지 마세요. Script Property(CAMP_INTERNAL_USER / CAMP_INTERNAL_PW_HASH / CAMP_INTERNAL_TOKEN_SECRET)에만 둡니다.
window.CAMP_CONFIG = Object.freeze({
  apiUrl: "",
  internalApiUrl: ""
});
