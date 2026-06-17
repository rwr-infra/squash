import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Card, Form, Input, Button, Typography, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { login, setToken } from '../services/apiService';

type LoginForm = { username: string; password: string };

const LoginPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const handleSubmit = async (values: LoginForm) => {
    setLoading(true);
    try {
      const { token } = await login(values.username, values.password);
      setToken(token);
      navigate(from, { replace: true });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: '#f0f2f5' }}>
      <Card style={{ width: '100%', maxWidth: 360, boxShadow: '0 4px 16px rgba(0,0,0,0.08)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>squash</Typography.Title>
          <Typography.Text type="secondary">Sign in to continue</Typography.Text>
        </div>
        <Form layout="vertical" onFinish={handleSubmit} requiredMark={false}>
          <Form.Item name="username" rules={[{ required: true, message: 'Please enter your username' }]}>
            <Input prefix={<UserOutlined />} placeholder="Username" size="large" autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: 'Please enter your password' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="Password" size="large" autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" size="large" block loading={loading}>
              Log in
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default LoginPage;
