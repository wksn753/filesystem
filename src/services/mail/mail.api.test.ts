import axios, { Axios } from "axios";

export class TestMailService implements MailService {

   private static instance: TestMailService;

   private constructor() {}
    static getInstance(): TestMailService {
    if (!TestMailService.instance) {
      TestMailService.instance = new TestMailService();
    }
    return TestMailService.instance;
  } 

  async sendMail(to: string, subject: string, body: string): Promise<void> {
    const from = "wksn753@gmail.com";
    const text = "";
    const html = body;
    const result = await axios.post(
      "https://multi-tenant-blog.onrender.com/mail/sendMailGeneric",
      {
        from,
        to,
        subject,
        text,
        html,
      }
    );
  }
}
