import nodemailer, { Transporter } from "nodemailer";

export class SMTPMailService implements MailService {
  private static instance: SMTPMailService;
  private readonly transporter: Transporter;

  private constructor() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT);
    const username = process.env.SMTP_USER;
    const password = process.env.SMTP_PASSWORD;

    if (!host || !port || !username || !password) {
      throw new Error("SMTP configuration is incomplete");
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user: username, pass: password },
      pool: true,
    });
  }

  static getInstance(): SMTPMailService {
    if (!SMTPMailService.instance) {
      SMTPMailService.instance = new SMTPMailService();
    }
    return SMTPMailService.instance;
  }

  async sendMail(
    from: string,
    to: string,
    subject: string,
    htmlBody: string
  ): Promise<void> {
    await this.transporter.sendMail({
      from,
      to,
      subject,
      html: htmlBody,
    });
  }
}
