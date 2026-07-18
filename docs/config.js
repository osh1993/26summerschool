// Apps Script 웹앱을 배포한 뒤 아래 주소를 입력하세요. 이 URL들은 비밀키가 아닙니다.
// - apiUrl: 공개(무인증) 스냅샷. /exec?view=public 주소. Apps Script는 공개 허용 필드만 반환해야 합니다.
// - internalApiUrl: 인증 내부 뷰. /exec 주소(같은 배포). 브라우저가 {user, password}를 POST하면
//   Apps Script가 서버에서 검증한 뒤에만 실명 포함 내부 스냅샷을 반환합니다.
//   비밀번호는 절대 이 파일에 넣지 마세요. Script Property(CAMP_INTERNAL_USER / CAMP_INTERNAL_PW_HASH)에만 둡니다.
window.CAMP_CONFIG = Object.freeze({
  apiUrl: "",
  internalApiUrl: ""
});
