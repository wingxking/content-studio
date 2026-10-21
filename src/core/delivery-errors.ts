/** Only explicitly authored messages may cross the public delivery boundary. */
export type DeliveryErrorCode = 'INPUT_INVALID' | 'UNSUPPORTED_ACTION' | 'UNSUPPORTED_FORMAT' | 'AUTHORIZATION_REQUIRED' | 'ACCOUNT_MISMATCH' | 'SERVICE_OFFLINE' | 'CONTENT_INVALID' | 'SERVICE_UNAVAILABLE';
export type DeliveryIssue = { code: DeliveryErrorCode; message: string; nextAction: string };

const actions: Record<DeliveryErrorCode, string> = {
  INPUT_INVALID: '打开任务检查当前内容与目标',
  UNSUPPORTED_ACTION: '选择支持的交付方式或手动交付',
  UNSUPPORTED_FORMAT: '在内容中调整平台版本的格式',
  AUTHORIZATION_REQUIRED: '在设置的账号连接中完成授权',
  ACCOUNT_MISMATCH: '核对目标账号与插件中登录的身份',
  SERVICE_OFFLINE: '连接 Chrome 插件后重新检查',
  CONTENT_INVALID: '修改平台版本后重新检查',
  SERVICE_UNAVAILABLE: '检查服务状态后重试',
};

export class DeliveryInputError extends Error {
  readonly code: DeliveryErrorCode;
  readonly nextAction: string;
  constructor(message: string, code: DeliveryErrorCode = 'INPUT_INVALID', nextAction = actions[code]) {
    super(message);
    this.name = 'DeliveryInputError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

export function deliveryIssue(error: unknown): DeliveryIssue {
  if (error instanceof DeliveryInputError) return { code: error.code, message: error.message, nextAction: error.nextAction };
  // Never derive public text or suggested actions from provider/runtime exception strings.
  return { code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请检查运行状态后重试。', nextAction: actions.SERVICE_UNAVAILABLE };
}
