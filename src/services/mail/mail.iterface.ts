interface MailService {
  sendMail(from: string, to: string, subject: string, htmlBody: string): Promise<void>;
}